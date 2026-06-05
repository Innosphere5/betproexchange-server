const WebSocket = require('ws');
const Match = require('../models/Match');
const MarketOdds = require('../models/MarketOdds');
const OddsMarket = require('../models/OddsMarket');
const oddsPapiRest = require('./oddsPapiRest');
require('dotenv').config();

// ─── Configuration ─────────────────────────────────────────────────────────────

const API_KEY = process.env.ODDS_API_KEY;
const WS_URL = 'wss://v5.oddspapi.io/ws';
const CRICKET_SPORT_ID = 27;
const BOOKMAKERS = ['betfair-ex', 'pinnacle'];
const STALE_TIMEOUT_MS = 60000;

// ─── OddsPapi WebSocket Service ────────────────────────────────────────────────

class OddsPapiService {
    constructor() {
        this.ws = null;
        this.io = null;

        // Resume state
        this.serverEpoch = null;
        this.replayChannels = null;
        this.lastSeenId = {};

        // Reconnect
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000;
        this.reconnectTimer = null;
        this.isConnecting = false;

        // Fixture mapping: OddsPapi fixtureId → DB matchId
        this.fixtureToMatchId = new Map();
        // OddsPapi fixtureId → fixture metadata (participants, sport, etc.)
        this.fixtureMetadata = new Map();

        // Odds cache: DB matchId → latest odds payload (for dedup)
        this.oddsCache = new Map();

        // Batched DB write queue: DB matchId → update payload
        this.writeQueue = new Map();
        this.writeInterval = null;

        // Stale check interval
        this.staleCheckInterval = null;
    }

    // ─── Public Init ───────────────────────────────────────────────────────────

    init(io) {
        if (!API_KEY) {
            console.error('[OddsPapi] ❌ Missing ODDS_API_KEY in environment');
            return;
        }

        this.io = io;
        this.writeInterval = setInterval(() => this.flushWriteQueue(), 1000);
        this.staleCheckInterval = setInterval(() => this.checkStaleOdds(), 20000);
        // Periodic REST poll: re-fetch odds for all linked live fixtures every 30s
        // This acts as a safety net when the WebSocket misses fixtures
        this.restPollInterval = setInterval(() => this.pollLinkedFixtures(), 30000);
        // Periodic poll for upcoming (pre-game) fixtures every 5 minutes
        // Keeps pre-match odds fresh and links new upcoming matches as they appear
        this.upcomingPollInterval = setInterval(() => this.pollUpcomingFixtures(), 5 * 60 * 1000);

        console.log('[OddsPapi] 🚀 Initializing OddsPapi v5 integration...');
        console.log(`[OddsPapi] 📌 Cricket sportId: ${CRICKET_SPORT_ID}`);
        console.log(`[OddsPapi] 📌 Bookmakers: ${BOOKMAKERS.join(', ')}`);
        console.log(`[OddsPapi] 📌 Primary: betfair-ex (exchange) | Fallback: pinnacle`);
        console.log(`[OddsPapi] 📌 Upcoming odds poll: every 5 minutes`);

        this.connect();
    }

    // ─── WebSocket Connection ──────────────────────────────────────────────────

    connect() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        console.log('[OddsPapi] 🔌 Connecting to WebSocket...');

        try {
            this.ws = new WebSocket(WS_URL, {
                handshakeTimeout: 10000
            });
        } catch (err) {
            console.error('[OddsPapi] ❌ WebSocket creation failed:', err.message);
            this.isConnecting = false;
            this.scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            console.log('[OddsPapi] ✅ WebSocket connected. Sending login...');
            this.isConnecting = false;
            this.sendLogin();
        });

        this.ws.on('message', (raw) => {
            try {
                const str = raw.toString();
                const msg = JSON.parse(str);
                this.handleMessage(msg);
            } catch (err) {
                console.error('[OddsPapi] ❌ Message parse error:', err.message);
            }
        });

        this.ws.on('close', (code, reason) => {
            this.isConnecting = false;
            const reasonStr = reason ? reason.toString() : 'unknown';
            console.warn(`[OddsPapi] ⚠️ WebSocket closed (code: ${code}, reason: ${reasonStr})`);
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            this.isConnecting = false;
            console.error('[OddsPapi] ❌ WebSocket error:', err.message);
        });
    }

    sendLogin() {
        const login = {
            type: 'login',
            apiKey: API_KEY,
            channels: ['fixtures', 'odds', 'scores', 'bookmakers'],
            sportIds: [CRICKET_SPORT_ID],
            bookmakers: BOOKMAKERS,
            receiveType: 'json',
            lang: 'en'
        };

        // Resume support
        if (this.serverEpoch) {
            login.serverEpoch = this.serverEpoch;
        }

        // Only send cursors for replayable channels
        const cursors = {};
        if (this.replayChannels) {
            for (const [ch, eid] of Object.entries(this.lastSeenId)) {
                if (this.replayChannels.has(ch)) {
                    cursors[ch] = eid;
                }
            }
        } else {
            Object.assign(cursors, this.lastSeenId);
        }

        if (Object.keys(cursors).length > 0) {
            login.lastSeenId = cursors;
            console.log('[OddsPapi] 🔄 Resuming with cursors:', cursors);
        }

        this.ws.send(JSON.stringify(login));
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;

        const delay = Math.min(
            Math.pow(2, this.reconnectAttempts) * 1000,
            this.maxReconnectDelay
        );
        this.reconnectAttempts++;

        console.log(`[OddsPapi] 🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    // ─── Message Router ────────────────────────────────────────────────────────

    handleMessage(msg) {
        const msgType = msg.type;
        const channel = msg.channel;

        // Track entryId for resume
        if (channel && msg.entryId) {
            this.lastSeenId[channel] = msg.entryId;
        }

        // Control messages
        if (msgType === 'login_ok') {
            this.handleLoginOk(msg);
            return;
        }

        if (msgType === 'login_failed') {
            console.error('[OddsPapi] ❌ Login failed:', msg.message || msg.code || JSON.stringify(msg));
            return;
        }

        if (msgType === 'reconnect') {
            console.warn('[OddsPapi] 🔄 Server requested reconnect:', msg.reason);
            if (this.ws) {
                this.ws.close();
            }
            return;
        }

        if (msgType === 'snapshot_required') {
            this.handleSnapshotRequired(msg);
            return;
        }

        if (msgType === 'resume_complete') {
            console.log('[OddsPapi] ✅ Resume complete');
            return;
        }

        if (msgType === 'error') {
            console.error('[OddsPapi] ❌ Server error:', msg.message || JSON.stringify(msg));
            return;
        }

        // Data messages (UPDATE)
        if (channel && msg.payload) {
            switch (channel) {
                case 'fixtures':
                    this.handleFixtureUpdate(msg.payload);
                    break;
                case 'odds':
                    this.handleOddsUpdate(msg.payload);
                    break;
                case 'scores':
                    this.handleScoreUpdate(msg.payload);
                    break;
                case 'bookmakers':
                    this.handleBookmakerUpdate(msg.payload);
                    break;
                default:
                    break;
            }
        }
    }

    // ─── Control Message Handlers ──────────────────────────────────────────────

    handleLoginOk(msg) {
        this.reconnectAttempts = 0;

        const resume = msg.resume || {};
        this.serverEpoch = resume.serverEpoch || this.serverEpoch;

        const rc = resume.replayChannels;
        if (Array.isArray(rc)) {
            this.replayChannels = new Set(rc.map(String));
        }

        const access = msg.access || {};
        console.log('[OddsPapi] ✅ Login successful!');
        console.log(`[OddsPapi]    Live access: ${access.live}, Pregame access: ${access.pregame}`);
        console.log(`[OddsPapi]    Channels: ${(msg.channels || []).join(', ')}`);
        console.log(`[OddsPapi]    Server epoch: ${this.serverEpoch}`);
        console.log(`[OddsPapi]    Replay channels: ${rc ? rc.join(', ') : 'none'}`);

        // Bootstrap: fetch fixture metadata via REST so odds can be matched immediately
        this.bootstrapFixtures();
    }

    async bootstrapFixtures() {
        console.log('[OddsPapi] 📸 Bootstrapping fixture metadata via REST...');

        try {
            const fixtures = await oddsPapiRest.getFixturesToday({
                sportId: CRICKET_SPORT_ID,
                bookmakers: BOOKMAKERS.join(',')
            });

            if (!fixtures || !Array.isArray(fixtures)) {
                console.warn('[OddsPapi] ⚠️ No fixtures returned for bootstrap');
            } else {
                let linked = 0;
                for (const fixture of fixtures) {
                    if (!fixture.fixtureId) continue;

                    // Store metadata from REST response
                    await this.handleFixtureUpdate(fixture);

                    // Try to link to DB match
                    const matchId = await this.linkFixtureToMatch(fixture.fixtureId);
                    if (matchId) linked++;
                }

                console.log(`[OddsPapi] 📸 Today bootstrap complete: ${fixtures.length} fixtures loaded, ${linked} linked to DB matches`);

                // Fetch initial odds snapshot for linked fixtures
                for (const [fixtureId] of this.fixtureToMatchId.entries()) {
                    try {
                        const oddsData = await oddsPapiRest.getFixtureOdds(fixtureId, BOOKMAKERS);
                        if (oddsData && oddsData.odds) {
                            await this.handleOddsUpdate({
                                fixtureId,
                                odds: oddsData.odds
                            });
                        }
                    } catch (err) {
                        // Non-fatal: WebSocket will deliver live updates
                    }
                }

                console.log('[OddsPapi] 📸 Initial odds snapshot complete');
            }

            // Also bootstrap upcoming (next 2 days) fixtures for pre-match odds
            await this.bootstrapUpcomingFixtures();

            // Also recover fixtures already linked in DB (MarketOdds/OddsMarket)
            // These might not appear in fixtures/today but still have valid odds
            await this.recoverLinkedFixtures();
        } catch (err) {
            console.error('[OddsPapi] ❌ Bootstrap failed:', err.message);
        }
    }

    async bootstrapUpcomingFixtures() {
        console.log('[OddsPapi] 📅 Bootstrapping upcoming fixtures (next 2 days) for pre-match odds...');

        try {
            // Build date range: today + next 2 days
            const dates = [];
            for (let i = 0; i <= 2; i++) {
                const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
                dates.push(d.toISOString().split('T')[0]);
            }

            // Fetch upcoming DB matches so we know what to look for
            const upcomingMatches = await Match.find({ status: 'upcoming' });
            if (upcomingMatches.length === 0) {
                console.log('[OddsPapi] 📅 No upcoming DB matches to link — skipping upcoming bootstrap');
                return;
            }

            console.log(`[OddsPapi] 📅 ${upcomingMatches.length} upcoming DB matches to link`);

            let totalLinked = 0;

            for (const dateStr of dates) {
                try {
                    const fixtures = await oddsPapiRest.getFixturesForDate(dateStr, {
                        sportId: CRICKET_SPORT_ID,
                        bookmakers: BOOKMAKERS.join(',')
                    });

                    const fixtureList = Array.isArray(fixtures)
                        ? fixtures
                        : (fixtures && Array.isArray(fixtures.data) ? fixtures.data : []);

                    for (const fixture of fixtureList) {
                        if (!fixture || !fixture.fixtureId) continue;
                        if (fixture.sport && fixture.sport.sportId !== CRICKET_SPORT_ID) continue;

                        // Store fixture metadata
                        await this.handleFixtureUpdate(fixture);

                        // Try to link to a DB upcoming match
                        const matchId = await this.linkFixtureToMatch(fixture.fixtureId);
                        if (matchId) {
                            totalLinked++;

                            // Fetch pre-match odds immediately
                            try {
                                const oddsData = await oddsPapiRest.getFixtureOdds(fixture.fixtureId, BOOKMAKERS);
                                if (oddsData && oddsData.odds) {
                                    await this.handleOddsUpdate({
                                        fixtureId: fixture.fixtureId,
                                        odds: oddsData.odds
                                    });
                                }
                            } catch (err) {
                                // Non-fatal: odds may not yet be available for far-future matches
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`[OddsPapi] ⚠️ Could not fetch fixtures for date ${dateStr}:`, err.message);
                }
            }

            console.log(`[OddsPapi] 📅 Upcoming bootstrap complete: ${totalLinked} fixtures linked`);
        } catch (err) {
            console.error('[OddsPapi] ❌ Upcoming bootstrap failed:', err.message);
        }
    }

    async recoverLinkedFixtures() {
        try {
            const activeMatches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
            if (activeMatches.length === 0) return;

            const marketOdds = await MarketOdds.find({
                matchId: { $in: activeMatches.map(m => m.matchId) },
                oddsApiEventId: { $exists: true, $ne: '' }
            });

            let recovered = 0;
            for (const mo of marketOdds) {
                const fixtureId = mo.oddsApiEventId;
                // Skip if already linked from the bootstrap
                if (this.fixtureToMatchId.has(fixtureId)) continue;

                // We have a fixture ID in the DB but it wasn't in fixtures/today
                // Try to fetch its metadata and odds directly
                try {
                    const fixtureData = await oddsPapiRest.getFixtures({
                        fixtureId,
                        sportId: CRICKET_SPORT_ID
                    });

                    // The response could be an array or single object
                    const fixtureList = Array.isArray(fixtureData) ? fixtureData : [fixtureData];
                    const fixture = fixtureList.find(f => f && f.fixtureId === fixtureId);

                    if (fixture) {
                        await this.handleFixtureUpdate(fixture);
                        this.fixtureToMatchId.set(fixtureId, mo.matchId);

                        // Fetch and process odds
                        const oddsData = await oddsPapiRest.getFixtureOdds(fixtureId, BOOKMAKERS);
                        if (oddsData && oddsData.odds) {
                            await this.handleOddsUpdate({
                                fixtureId,
                                odds: oddsData.odds
                            });
                        }
                        recovered++;
                        console.log(`[OddsPapi] 🔄 Recovered fixture ${fixtureId} for match ${mo.matchId}`);
                    }
                } catch (err) {
                    // Non-fatal: this fixture might be expired
                }
            }

            if (recovered > 0) {
                console.log(`[OddsPapi] 🔄 Recovered ${recovered} fixtures from DB`);
            }
        } catch (err) {
            console.error('[OddsPapi] ❌ Fixture recovery failed:', err.message);
        }
    }

    async handleSnapshotRequired(msg) {
        const channels = msg.channels || [];
        console.warn(`[OddsPapi] ⚠️ Snapshot required for: ${channels.join(', ')} (reason: ${msg.reason})`);

        // Clear cursors for affected channels
        for (const ch of channels) {
            delete this.lastSeenId[ch];
        }

        // Fetch REST snapshot for odds if needed
        if (channels.includes('odds') || channels.includes('fixtures')) {
            try {
                await this.fetchOddsSnapshot();
            } catch (err) {
                console.error('[OddsPapi] ❌ Snapshot fetch failed:', err.message);
            }
        }
    }

    // ─── Fixture Channel Handler ───────────────────────────────────────────────

    async handleFixtureUpdate(payload) {
        if (!payload || !payload.fixtureId) return;

        const { fixtureId, participants, sport, tournament, status, startTime, scores } = payload;

        // Only process cricket fixtures
        if (sport && sport.sportId !== CRICKET_SPORT_ID) return;

        // Store fixture metadata for later odds matching
        this.fixtureMetadata.set(fixtureId, {
            fixtureId,
            participant1Name: participants?.participant1Name || '',
            participant2Name: participants?.participant2Name || '',
            participant1Id: participants?.participant1Id,
            participant2Id: participants?.participant2Id,
            sportId: sport?.sportId,
            tournamentName: tournament?.tournamentName || '',
            categoryName: tournament?.categoryName || '',
            startTime: startTime,
            isLive: status?.live || false,
            statusName: status?.statusName || '',
            scores: scores || {}
        });

        // Try to link this fixture to a DB match
        await this.linkFixtureToMatch(fixtureId);
    }

    // ─── Odds Channel Handler ──────────────────────────────────────────────────

    async handleOddsUpdate(payload) {
        if (!payload || !payload.fixtureId || !payload.odds) return;

        const { fixtureId, odds } = payload;

        // Get fixture metadata
        let metadata = this.fixtureMetadata.get(fixtureId);

        // If no metadata yet, we can't map to participants — store odds for later
        if (!metadata) {
            // Try to fetch from REST if we don't have metadata
            return;
        }

        // Get DB match ID
        let matchId = this.fixtureToMatchId.get(fixtureId);
        if (!matchId) {
            // Try linking
            matchId = await this.linkFixtureToMatch(fixtureId);
            if (!matchId) return;
        }

        // Parse odds from bookmakers — betfair-ex primary, pinnacle fallback
        // parsed.teamA = participant1's odds, parsed.teamB = participant2's odds
        const parsed = this.parseOdds(odds, metadata);
        if (!parsed) return;

        // ─── Team Order Alignment ──────────────────────────────────────────
        // The API's participant1/participant2 order may not match the DB's
        // teamA/teamB order. Detect if the order is reversed and swap.
        let needsSwap = false;
        try {
            const dbMatch = await Match.findOne({ matchId });
            if (dbMatch) {
                const dbTeamA = this.normalize(dbMatch.teamA);
                const apiParticipant1 = this.normalize(metadata.participant1Name);
                const apiParticipant2 = this.normalize(metadata.participant2Name);

                // If API's participant1 matches DB's teamB, the order is reversed
                if (dbTeamA === apiParticipant2 && dbTeamA !== apiParticipant1) {
                    needsSwap = true;
                    console.log(`[OddsPapi] 🔄 Team order swap detected: API has ${metadata.participant1Name}/${metadata.participant2Name}, DB has ${dbMatch.teamA}/${dbMatch.teamB}`);
                }
            }
        } catch (err) {
            console.error('[OddsPapi] ❌ Team order check failed:', err.message);
        }

        // Apply swap: ensure parsed odds align with DB teamA/teamB order
        const alignedTeamA = needsSwap ? parsed.teamB : parsed.teamA;
        const alignedTeamB = needsSwap ? parsed.teamA : parsed.teamB;

        const now = new Date();
        const oddsPayload = {
            matchId,
            teamABack: alignedTeamA.back,
            teamALay: alignedTeamA.lay,
            teamBBack: alignedTeamB.back,
            teamBLay: alignedTeamB.lay,
            depthBackA: alignedTeamA.depthBack,
            depthLayA: alignedTeamA.depthLay,
            depthBackB: alignedTeamB.depthBack,
            depthLayB: alignedTeamB.depthLay,
            bookmaker: parsed.source,
            isLive: metadata.isLive,
            updatedAt: now
        };

        // Dedup check
        const cached = this.oddsCache.get(matchId);
        const changed = !cached ||
            cached.teamABack !== oddsPayload.teamABack ||
            cached.teamALay !== oddsPayload.teamALay ||
            cached.teamBBack !== oddsPayload.teamBBack ||
            cached.teamBLay !== oddsPayload.teamBLay;

        if (!changed) return;

        this.oddsCache.set(matchId, oddsPayload);

        // Use DB team names for Socket.IO emit (correct order)
        const dbTeamAName = needsSwap ? metadata.participant2Name : metadata.participant1Name;
        const dbTeamBName = needsSwap ? metadata.participant1Name : metadata.participant2Name;

        // Emit to UI instantly via Socket.IO
        if (this.io) {
            this.io.emit('market_odds_update', {
                matchId,
                updatedAt: now,
                marketStatus: 'OPEN',
                runners: [
                    {
                        name: dbTeamAName,
                        back: alignedTeamA.back,
                        lay: alignedTeamA.lay,
                        depthBack: alignedTeamA.depthBack,
                        depthLay: alignedTeamA.depthLay
                    },
                    {
                        name: dbTeamBName,
                        back: alignedTeamB.back,
                        lay: alignedTeamB.lay,
                        depthBack: alignedTeamB.depthBack,
                        depthLay: alignedTeamB.depthLay
                    }
                ]
            });
        }

        // Queue for batched DB write
        this.writeQueue.set(matchId, {
            ...oddsPayload,
            oddsPapiFixtureId: fixtureId,
            teamA: dbTeamAName,
            teamB: dbTeamBName,
            marketStatus: 'OPEN'
        });
    }

    // ─── Scores Channel Handler ────────────────────────────────────────────────

    handleScoreUpdate(payload) {
        if (!payload || !payload.fixtureId) return;

        const { fixtureId, scores } = payload;

        // Update fixture metadata scores
        const metadata = this.fixtureMetadata.get(fixtureId);
        if (metadata) {
            metadata.scores = scores || {};
        }
    }

    // ─── Bookmakers Channel Handler ────────────────────────────────────────────

    async handleBookmakerUpdate(payload) {
        if (!payload || !payload.fixtureId || !payload.bookmakers) return;

        const { fixtureId, bookmakers } = payload;
        const matchId = this.fixtureToMatchId.get(fixtureId);
        if (!matchId) return;

        // Check if our target bookmakers have staleOdds or suspended
        for (const bk of BOOKMAKERS) {
            const bkMeta = bookmakers[bk];
            if (!bkMeta) continue;

            if (bkMeta.staleOdds || bkMeta.suspended) {
                console.warn(`[OddsPapi] ⚠️ ${bk} is ${bkMeta.staleOdds ? 'STALE' : 'SUSPENDED'} for fixture ${fixtureId}`);

                // Emit suspended status if both bookmakers are down
                const otherBk = BOOKMAKERS.find(b => b !== bk);
                const otherMeta = bookmakers[otherBk];
                if (!otherMeta || otherMeta.staleOdds || otherMeta.suspended) {
                    if (this.io) {
                        this.io.emit('market_odds_update', { matchId, marketStatus: 'SUSPENDED' });
                    }
                    await this.updateMarketStatus(matchId, 'SUSPENDED');
                }
            }
        }
    }

    // ─── Odds Parsing ──────────────────────────────────────────────────────────

    parseOdds(oddsMap, metadata) {
        // Try betfair-ex first (exchange with back/lay order book)
        const betfairOdds = oddsMap['betfair-ex'];
        if (betfairOdds && Object.keys(betfairOdds).length > 0) {
            const parsed = this.parseBookmakerOdds(betfairOdds, metadata, 'betfair-ex', true);
            if (parsed) return parsed;
        }

        // Fallback to pinnacle
        const pinnacleOdds = oddsMap['pinnacle'];
        if (pinnacleOdds && Object.keys(pinnacleOdds).length > 0) {
            const parsed = this.parseBookmakerOdds(pinnacleOdds, metadata, 'pinnacle', false);
            if (parsed) return parsed;
        }

        return null;
    }

    parseBookmakerOdds(bookmakerOdds, metadata, source, isExchange) {
        // Group odds by marketId to find the Match Winner / Moneyline market
        // Each entry: oddsId → OddQuote
        const oddsEntries = Object.values(bookmakerOdds);

        if (oddsEntries.length === 0) return null;

        // Filter for active, main line odds only
        const activeOdds = oddsEntries.filter(o => o.active !== false);
        if (activeOdds.length === 0) return null;

        // Group by marketId
        const marketGroups = {};
        for (const odd of activeOdds) {
            const mId = odd.marketId;
            if (!marketGroups[mId]) marketGroups[mId] = [];
            marketGroups[mId].push(odd);
        }

        // Find the Match Winner market — it should have exactly 2 outcomes (for cricket)
        // and ideally be the main line
        let winnerMarket = null;
        let winnerMarketId = null;

        for (const [mId, outcomes] of Object.entries(marketGroups)) {
            // Match winner has exactly 2 outcomes for cricket (team A wins, team B wins)
            // Filter for mainLine if available
            const mainLineOutcomes = outcomes.filter(o => o.mainLine === true || o.mainLine === null || o.mainLine === undefined);

            if (mainLineOutcomes.length === 2) {
                // Check if all outcomes have playerId = 0 (non-player market)
                const allNonPlayer = mainLineOutcomes.every(o => o.playerId === 0);
                if (allNonPlayer) {
                    winnerMarket = mainLineOutcomes;
                    winnerMarketId = mId;
                    break;
                }
            }
        }

        if (!winnerMarket || winnerMarket.length !== 2) {
            // Try any market with 2 outcomes as fallback
            for (const [mId, outcomes] of Object.entries(marketGroups)) {
                if (outcomes.length === 2 && outcomes.every(o => o.playerId === 0)) {
                    winnerMarket = outcomes;
                    winnerMarketId = mId;
                    break;
                }
            }
        }

        if (!winnerMarket || winnerMarket.length < 2) return null;

        // Map outcomes to participant1 and participant2 using participantId from
        // fixture metadata. This is more reliable than sorting by outcomeId which
        // is a bookmaker-specific identifier.
        let participant1Odd = null;
        let participant2Odd = null;

        if (metadata.participant1Id || metadata.participant2Id) {
            for (const odd of winnerMarket) {
                if (odd.participantId === metadata.participant1Id) {
                    participant1Odd = odd;
                } else if (odd.participantId === metadata.participant2Id) {
                    participant2Odd = odd;
                }
            }
        }

        // Fallback: if participantId mapping didn't work, sort by outcomeId
        if (!participant1Odd || !participant2Odd) {
            winnerMarket.sort((a, b) => a.outcomeId - b.outcomeId);
            participant1Odd = winnerMarket[0];
            participant2Odd = winnerMarket[1];
        }

        let teamA, teamB;

        if (isExchange) {
            // Exchange: use meta.back and meta.lay for real exchange prices
            teamA = this.parseExchangeOdd(participant1Odd);
            teamB = this.parseExchangeOdd(participant2Odd);
        } else {
            // Traditional bookmaker: price is the back odds, synthesize lay
            teamA = this.parseTraditionalOdd(participant1Odd);
            teamB = this.parseTraditionalOdd(participant2Odd);
        }

        return {
            teamA,
            teamB,
            source,
            marketId: winnerMarketId
        };
    }

    parseExchangeOdd(odd) {
        let back = 0, lay = 0, depthBack = '0', depthLay = '0';

        // Primary: use meta.availableToBack and meta.availableToLay order book
        if (odd.meta) {
            const backBook = odd.meta.availableToBack || odd.meta.back || [];
            const layBook = odd.meta.availableToLay || odd.meta.lay || [];

            if (backBook.length > 0) {
                // Best back price is the highest in the back array
                const bestBack = backBook.reduce((best, curr) =>
                    curr.price > best.price ? curr : best, backBook[0]);
                back = bestBack.price;
                depthBack = this.formatDepth(bestBack.size);
            }

            if (layBook.length > 0) {
                // Best lay price is the lowest in the lay array
                const bestLay = layBook.reduce((best, curr) =>
                    curr.price < best.price ? curr : best, layBook[0]);
                lay = bestLay.price;
                depthLay = this.formatDepth(bestLay.size);
            }
        }

        // Fallback: use the flat price field if meta is missing or empty
        if (back === 0 && odd.price) {
            back = odd.price;
            depthBack = this.formatDepth(odd.limit);
        }

        // If no lay, synthesize a tight spread
        if (lay === 0 && back > 0) {
            lay = Number((back + 0.02).toFixed(2));
            depthLay = this.formatDepth(null);
        }

        return { back, lay, depthBack, depthLay };
    }

    parseTraditionalOdd(odd) {
        const back = odd.price || 0;
        const depthBack = this.formatDepth(odd.limit);

        // Traditional bookmakers don't have lay prices — synthesize
        const lay = back > 0 ? Number((back + 0.01).toFixed(2)) : 0;
        const depthLay = this.formatDepth(null);

        return { back, lay, depthBack, depthLay };
    }

    formatDepth(val) {
        if (!val && val !== 0) return '100';
        const n = Number(val);
        if (isNaN(n)) return String(val);
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return Math.floor(n).toString();
    }

    // ─── Fixture ↔ Match Linking ───────────────────────────────────────────────

    async linkFixtureToMatch(fixtureId) {
        // Already linked?
        if (this.fixtureToMatchId.has(fixtureId)) {
            return this.fixtureToMatchId.get(fixtureId);
        }

        const metadata = this.fixtureMetadata.get(fixtureId);
        if (!metadata || !metadata.participant1Name || !metadata.participant2Name) {
            return null;
        }

        try {
            const matches = await Match.find({
                status: { $in: ['live', 'upcoming'] }
            });

            const apiHome = this.normalize(metadata.participant1Name);
            const apiAway = this.normalize(metadata.participant2Name);
            const apiTime = metadata.startTime ? metadata.startTime * 1000 : 0;

            for (const match of matches) {
                const dbHome = this.normalize(match.teamA);
                const dbAway = this.normalize(match.teamB);
                const dbTime = new Date(match.startTime).getTime();

                const teamsMatch =
                    (dbHome === apiHome && dbAway === apiAway) ||
                    (dbHome === apiAway && dbAway === apiHome);

                if (teamsMatch) {
                    const timeDiff = apiTime > 0 ? Math.abs(dbTime - apiTime) / (1000 * 60 * 60) : 0;
                    if (timeDiff <= 12 || apiTime === 0) {
                        this.fixtureToMatchId.set(fixtureId, match.matchId);
                        console.log(`[OddsPapi] 🔗 Linked ${metadata.participant1Name} v ${metadata.participant2Name} → match ${match.matchId}`);
                        return match.matchId;
                    }
                }
            }
        } catch (err) {
            console.error(`[OddsPapi] ❌ Fixture linking error for ${fixtureId}:`, err.message);
        }

        return null;
    }

    normalize(name) {
        if (!name) return '';
        let n = name.toLowerCase().trim();

        n = n.replace(/\bwomen\b/g, '');
        n = n.replace(/\bw\b/g, '');
        n = n.replace(/\bteam\b/g, '');
        n = n.replace(/\bcricket\b/g, '');
        n = n.replace(/\bnational\b/g, '');
        n = n.replace(/\bmen\b/g, '');
        n = n.replace(/\bxi\b/g, '');

        n = n.replace(/[^a-z0-9\s]/g, '');
        n = n.replace(/\s+/g, '');

        const aliases = {
            'royalchallengers': 'rcb',
            'bengaluru': 'rcb',
            'bangalore': 'rcb',
            'lucknow': 'lsg',
            'sunrisers': 'srh',
            'hyderabad': 'srh',
            'mumbaiindians': 'mi',
            'mumbai': 'mi',
            'chennaisuperkings': 'csk',
            'chennai': 'csk',
            'delhicapitals': 'dc',
            'delhi': 'dc',
            'rajasthanroyals': 'rr',
            'rajasthan': 'rr',
            'gujarattitans': 'gt',
            'gujarat': 'gt',
            'kolkataknightriders': 'kkr',
            'kolkata': 'kkr',
            'punjabkings': 'pbks',
            'kingsxi': 'pbks',
            'punjab': 'pbks'
        };

        for (const [key, value] of Object.entries(aliases)) {
            if (n.includes(key)) return value;
        }
        return n;
    }

    // ─── REST Snapshot Recovery ─────────────────────────────────────────────────

    async fetchOddsSnapshot() {
        console.log('[OddsPapi] 📸 Fetching odds snapshot via REST...');

        try {
            // Fetch today's cricket fixtures
            const fixtures = await oddsPapiRest.getFixturesToday({
                sportId: CRICKET_SPORT_ID,
                bookmakers: BOOKMAKERS.join(',')
            });

            if (!fixtures || !Array.isArray(fixtures)) {
                console.warn('[OddsPapi] No fixtures returned from REST snapshot');
                return;
            }

            console.log(`[OddsPapi] 📸 Got ${fixtures.length} cricket fixtures from REST`);

            // Process each fixture
            for (const fixture of fixtures) {
                if (fixture.fixtureId) {
                    // Store metadata
                    this.handleFixtureUpdate(fixture);

                    // Fetch odds for this fixture if it has bookmakers
                    if (fixture.bookmakers && Object.keys(fixture.bookmakers).length > 0) {
                        try {
                            const oddsData = await oddsPapiRest.getFixtureOdds(
                                fixture.fixtureId,
                                BOOKMAKERS
                            );

                            if (oddsData && oddsData.odds) {
                                this.handleOddsUpdate({
                                    fixtureId: fixture.fixtureId,
                                    odds: oddsData.odds
                                });
                            }
                        } catch (err) {
                            console.error(`[OddsPapi] ❌ Odds fetch failed for ${fixture.fixtureId}:`, err.message);
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[OddsPapi] ❌ REST snapshot failed:', err.message);
        }
    }

    // ─── DB Persistence (Batched) ──────────────────────────────────────────────

    async flushWriteQueue() {
        if (this.writeQueue.size === 0) return;

        const updates = Array.from(this.writeQueue.values());
        this.writeQueue.clear();

        for (const update of updates) {
            try {
                // Update MarketOdds collection
                await MarketOdds.findOneAndUpdate(
                    { matchId: update.matchId },
                    {
                        matchId: update.matchId,
                        oddsApiEventId: update.oddsPapiFixtureId || '',
                        teamA: { back: update.teamABack, lay: update.teamALay },
                        teamB: { back: update.teamBBack, lay: update.teamBLay },
                        bookmaker: update.bookmaker,
                        marketStatus: update.marketStatus,
                        updatedAt: update.updatedAt
                    },
                    { upsert: true }
                );

                // Update OddsMarket collection
                await OddsMarket.findOneAndUpdate(
                    { sportmonksMatchId: update.matchId },
                    {
                        sportmonksMatchId: update.matchId,
                        oddsApiEventId: update.oddsPapiFixtureId || '',
                        teamA: update.teamA,
                        teamB: update.teamB,
                        teamABack: update.teamABack,
                        teamALay: update.teamALay,
                        teamBBack: update.teamBBack,
                        teamBLay: update.teamBLay,
                        bookmaker: update.bookmaker,
                        marketStatus: update.marketStatus,
                        isLive: update.isLive,
                        updatedAt: update.updatedAt
                    },
                    { upsert: true }
                );

                // Update Match collection for backward compatibility
                await Match.findOneAndUpdate(
                    { matchId: update.matchId },
                    {
                        backOddsA: update.teamABack,
                        layOddsA: update.teamALay,
                        backOddsB: update.teamBBack,
                        layOddsB: update.teamBLay,
                        depthBackA: update.depthBackA,
                        depthLayA: update.depthLayA,
                        depthBackB: update.depthBackB,
                        depthLayB: update.depthLayB,
                        marketStatus: 'OPEN',
                        lastUpdated: update.updatedAt
                    }
                );
            } catch (err) {
                console.error(`[OddsPapi] ❌ DB write failed for ${update.matchId}:`, err.message);
            }
        }
    }

    // ─── Market Status ─────────────────────────────────────────────────────────

    async updateMarketStatus(matchId, status) {
        try {
            await MarketOdds.findOneAndUpdate(
                { matchId },
                { marketStatus: status, updatedAt: new Date() }
            );
            await Match.findOneAndUpdate(
                { matchId },
                { marketStatus: status, lastUpdated: new Date() }
            );
        } catch (err) {
            console.error(`[OddsPapi] ❌ Status update failed for ${matchId}:`, err.message);
        }
    }

    async checkStaleOdds() {
        try {
            const staleTime = new Date(Date.now() - STALE_TIMEOUT_MS);
            const staleMarkets = await MarketOdds.find({
                updatedAt: { $lt: staleTime },
                marketStatus: 'OPEN'
            });

            for (const market of staleMarkets) {
                const match = await Match.findOne({ matchId: market.matchId });
                if (match && match.status === 'live') {
                    await this.updateMarketStatus(market.matchId, 'SUSPENDED');
                    if (this.io) {
                        this.io.emit('market_odds_update', {
                            matchId: market.matchId,
                            marketStatus: 'SUSPENDED'
                        });
                    }
                }
            }
        } catch (err) {
            console.error('[OddsPapi] ❌ Stale odds check failed:', err.message);
        }
    }

    async pollLinkedFixtures() {
        try {
            // Re-fetch odds for all linked LIVE fixtures via REST
            // This is a safety net for when the WebSocket doesn't stream certain fixtures
            const liveMatches = await Match.find({ status: 'live' });
            if (liveMatches.length === 0) return;

            for (const [fixtureId, matchId] of this.fixtureToMatchId.entries()) {
                const isLive = liveMatches.some(m => m.matchId === matchId);
                if (!isLive) continue;

                try {
                    const oddsData = await oddsPapiRest.getFixtureOdds(fixtureId, BOOKMAKERS);
                    if (oddsData && oddsData.odds) {
                        await this.handleOddsUpdate({
                            fixtureId,
                            odds: oddsData.odds
                        });
                    }
                } catch (err) {
                    // Non-fatal: individual fixture fetch may fail
                }
            }
        } catch (err) {
            console.error('[OddsPapi] ❌ REST live poll failed:', err.message);
        }
    }

    async pollUpcomingFixtures() {
        try {
            // Re-fetch pre-match odds for all linked UPCOMING fixtures
            // Runs every 5 minutes — pre-game odds change slowly
            const upcomingMatches = await Match.find({ status: 'upcoming' });
            if (upcomingMatches.length === 0) return;

            const upcomingMatchIds = new Set(upcomingMatches.map(m => m.matchId));
            let polled = 0;

            for (const [fixtureId, matchId] of this.fixtureToMatchId.entries()) {
                if (!upcomingMatchIds.has(matchId)) continue;

                try {
                    const oddsData = await oddsPapiRest.getFixtureOdds(fixtureId, BOOKMAKERS);
                    if (oddsData && oddsData.odds) {
                        await this.handleOddsUpdate({
                            fixtureId,
                            odds: oddsData.odds
                        });
                        polled++;
                    }
                } catch (err) {
                    // Non-fatal
                }
            }

            // Also try to link any unlinked upcoming matches (new ones added since bootstrap)
            const unlinkedUpcoming = upcomingMatches.filter(
                m => !Array.from(this.fixtureToMatchId.values()).includes(m.matchId)
            );

            if (unlinkedUpcoming.length > 0) {
                console.log(`[OddsPapi] 📅 Attempting to link ${unlinkedUpcoming.length} unlinked upcoming matches...`);
                await this.bootstrapUpcomingFixtures();
            }

            if (polled > 0) {
                console.log(`[OddsPapi] 📅 Polled pre-match odds for ${polled} upcoming fixtures`);
            }
        } catch (err) {
            console.error('[OddsPapi] ❌ REST upcoming poll failed:', err.message);
        }
    }

    // ─── Cleanup ───────────────────────────────────────────────────────────────

    destroy() {
        if (this.writeInterval) clearInterval(this.writeInterval);
        if (this.staleCheckInterval) clearInterval(this.staleCheckInterval);
        if (this.restPollInterval) clearInterval(this.restPollInterval);
        if (this.upcomingPollInterval) clearInterval(this.upcomingPollInterval);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
        }
    }
}

module.exports = new OddsPapiService();
