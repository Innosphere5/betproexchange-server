const WebSocket = require('ws');
const Match = require('../models/Match');
const MarketOdds = require('../models/MarketOdds');
const OddsMarket = require('../models/OddsMarket');
const oddsApiRest = require('./oddsApiRest');
require('dotenv').config();

// ─── Configuration ─────────────────────────────────────────────────────────────

const API_KEY = process.env.ODDS_API_KEY;
const WS_BASE_URL = 'wss://api.odds-api.io/v3/ws';
const SPORT = 'cricket';
const MARKETS = 'h2h';
const CHANNELS = 'odds,scores,status';
// Bookmaker targets are filtered here if needed, but the WS url might fetch all.
// The user noted: "Your current code targets betfair-ex (exchange) and pinnacle. On odds-api.io, the equivalent would be Betfair Exchange and Pinnacle. I'll use odds-api.io's naming convention."
// However, the internal API keys for these are typically betfair_ex and bet365.
const BOOKMAKERS = ['betfair_ex', 'bet365'];
const STALE_TIMEOUT_MS = 60000;

class OddsApiLiveService {
    constructor() {
        this.ws = null;
        this.io = null;

        // Resume state
        this.lastSeq = null;

        // Reconnect
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000;
        this.reconnectTimer = null;
        this.isConnecting = false;

        // Fixture mapping: eventId → DB matchId
        this.eventToMatchId = new Map();
        // eventId → fixture metadata (home, away, etc.)
        this.eventMetadata = new Map();

        // Cached needsSwap per matchId to prevent DB queries on every tick
        this.swapCache = new Map();

        // Odds cache: DB matchId → latest odds payload (for dedup)
        this.oddsCache = new Map();

        // Batched DB write queue: DB matchId → update payload
        this.writeQueue = new Map();
        this.writeInterval = null;

        // Stale check interval
        this.staleCheckInterval = null;
    }

    init(io) {
        if (!API_KEY) {
            console.error('[OddsApiLive] ❌ Missing ODDS_API_KEY in environment');
            return;
        }

        this.io = io;
        this.writeInterval = setInterval(() => this.flushWriteQueue(), 1000);
        this.staleCheckInterval = setInterval(() => this.checkStaleOdds(), 20000);
        this.restPollInterval = setInterval(() => this.pollLinkedFixtures(), 30000);
        this.upcomingPollInterval = setInterval(() => this.pollUpcomingFixtures(), 5 * 60 * 1000);

        console.log('[OddsApiLive] 🚀 Initializing odds-api.io v3 integration...');
        this.connect();
    }

    connect() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        let url = `${WS_BASE_URL}?apiKey=${API_KEY}&sport=${SPORT}&markets=${MARKETS}&channels=${CHANNELS}`;
        if (this.lastSeq) {
            url += `&lastSeq=${this.lastSeq}`;
            console.log(`[OddsApiLive] 🔄 Resuming from seq: ${this.lastSeq}`);
        }

        console.log('[OddsApiLive] 🔌 Connecting to WebSocket...');

        try {
            this.ws = new WebSocket(url, { handshakeTimeout: 10000 });
        } catch (err) {
            console.error('[OddsApiLive] ❌ WebSocket creation failed:', err.message);
            this.isConnecting = false;
            this.scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            console.log('[OddsApiLive] ✅ WebSocket connected.');
            this.isConnecting = false;
            // No login needed, wait for 'welcome' msg
        });

        this.ws.on('message', (raw) => {
            try {
                const str = raw.toString();
                const lines = str.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        this.handleMessage(msg);
                    } catch (err) {
                        console.error('[OddsApiLive] ❌ Message parse error on chunk:', err.message);
                    }
                }
            } catch (err) {
                console.error('[OddsApiLive] ❌ Message read error:', err.message);
            }
        });

        this.ws.on('close', (code, reason) => {
            this.isConnecting = false;
            console.warn(`[OddsApiLive] ⚠️ WebSocket closed (code: ${code})`);
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            this.isConnecting = false;
            console.error('[OddsApiLive] ❌ WebSocket error:', err.message);
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;

        const delay = Math.min(
            Math.pow(2, this.reconnectAttempts) * 1000,
            this.maxReconnectDelay
        );
        this.reconnectAttempts++;

        console.log(`[OddsApiLive] 🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    handleMessage(msg) {
        if (msg.seq) {
            this.lastSeq = msg.seq;
        }

        const type = msg.type || msg.channel;

        switch (type) {
            case 'welcome':
                this.reconnectAttempts = 0;
                console.log('[OddsApiLive] ✅ Received welcome message. Triggering bootstrap...');
                this.bootstrapFixtures();
                break;
            case 'created':
            case 'updated':
                this.handleOddsData(msg);
                break;
            case 'deleted':
                this.handleDeleted(msg);
                break;
            case 'score':
                this.handleScoreUpdate(msg);
                break;
            case 'status':
                this.handleStatusUpdate(msg);
                break;
            case 'resync_required':
                console.warn('[OddsApiLive] 🔄 Resync required. Fetching snapshot and reconnecting.');
                this.lastSeq = null; // Drop seq to start fresh
                this.fetchOddsSnapshot().then(() => {
                    if (this.ws) this.ws.close();
                });
                break;
            default:
                break;
        }
    }

    async bootstrapFixtures() {
        console.log('[OddsApiLive] 📸 Bootstrapping fixture metadata via REST...');
        try {
            const fixtures = await oddsApiRest.getFixturesToday();
            if (fixtures && Array.isArray(fixtures)) {
                let linked = 0;
                for (const fixture of fixtures) {
                    this.storeFixtureMetadata(fixture);
                    const matchId = await this.linkEventToMatch(fixture.id);
                    if (matchId) linked++;
                }
                console.log(`[OddsApiLive] 📸 Today bootstrap complete: ${fixtures.length} events loaded, ${linked} linked.`);
                
                // Fetch odds for linked
                for (const [eventId] of this.eventToMatchId.entries()) {
                    try {
                        const oddsData = await oddsApiRest.getFixtureOdds(eventId);
                        if (oddsData && Array.isArray(oddsData)) {
                            for (const odd of oddsData) {
                                await this.processOddsForEvent(odd);
                            }
                        }
                    } catch (err) {}
                }
            }

            await this.bootstrapUpcomingFixtures();
            await this.recoverLinkedFixtures();
        } catch (err) {
            console.error('[OddsApiLive] ❌ Bootstrap failed:', err.message);
        }
    }

    async bootstrapUpcomingFixtures() {
        console.log('[OddsApiLive] 📅 Bootstrapping upcoming fixtures...');
        try {
            const dates = [];
            for (let i = 0; i <= 2; i++) {
                const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
                dates.push(d.toISOString().split('T')[0]);
            }

            const upcomingMatches = await Match.find({ status: 'upcoming' });
            if (upcomingMatches.length === 0) return;

            let totalLinked = 0;
            for (const dateStr of dates) {
                try {
                    const fixtures = await oddsApiRest.getFixturesForDate(dateStr);
                    if (fixtures && Array.isArray(fixtures)) {
                        for (const fixture of fixtures) {
                            this.storeFixtureMetadata(fixture);
                            const matchId = await this.linkEventToMatch(fixture.id);
                            if (matchId) {
                                totalLinked++;
                                try {
                                    const oddsData = await oddsApiRest.getFixtureOdds(fixture.id);
                                    if (oddsData && Array.isArray(oddsData)) {
                                        for (const odd of oddsData) {
                                            await this.processOddsForEvent(odd);
                                        }
                                    }
                                } catch (err) {}
                            }
                        }
                    }
                } catch (err) {}
            }
            console.log(`[OddsApiLive] 📅 Upcoming bootstrap complete: ${totalLinked} linked.`);
        } catch (err) {
            console.error('[OddsApiLive] ❌ Upcoming bootstrap failed:', err.message);
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
                const eventId = mo.oddsApiEventId;
                if (this.eventToMatchId.has(eventId)) continue;

                try {
                    const fixtureData = await oddsApiRest.getFixtures({ id: eventId });
                    const fixtures = Array.isArray(fixtureData) ? fixtureData : [fixtureData];
                    const fixture = fixtures.find(f => f && f.id === eventId);

                    if (fixture) {
                        this.storeFixtureMetadata(fixture);
                        this.eventToMatchId.set(eventId, mo.matchId);

                        const oddsData = await oddsApiRest.getFixtureOdds(eventId);
                        if (oddsData && Array.isArray(oddsData)) {
                            for (const odd of oddsData) {
                                await this.processOddsForEvent(odd);
                            }
                        }
                        recovered++;
                    }
                } catch (err) {}
            }
            if (recovered > 0) console.log(`[OddsApiLive] 🔄 Recovered ${recovered} fixtures from DB`);
        } catch (err) {}
    }

    storeFixtureMetadata(fixture) {
        if (!fixture || !fixture.id) return;
        this.eventMetadata.set(fixture.id, {
            eventId: fixture.id,
            home: fixture.home_team || fixture.home,
            away: fixture.away_team || fixture.away,
            sport: fixture.sport_key || fixture.sport,
            commenceTime: fixture.commence_time,
            isLive: fixture.status === 'live'
        });
    }

    async linkEventToMatch(eventId) {
        if (this.eventToMatchId.has(eventId)) {
            return this.eventToMatchId.get(eventId);
        }

        // Add cooldown to prevent spamming DB for unlinked events
        if (!this.linkCooldown) this.linkCooldown = new Map();
        if (this.linkCooldown.has(eventId)) {
            const lastAttempt = this.linkCooldown.get(eventId);
            if (Date.now() - lastAttempt < 30000) return null; // 30s cooldown
        }
        this.linkCooldown.set(eventId, Date.now());

        const metadata = this.eventMetadata.get(eventId);
        if (!metadata || !metadata.home || !metadata.away) return null;

        try {
            const matches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
            const apiHome = this.normalize(metadata.home);
            const apiAway = this.normalize(metadata.away);
            const apiTime = metadata.commenceTime ? new Date(metadata.commenceTime).getTime() : 0;

            for (const match of matches) {
                const dbHome = this.normalize(match.teamA);
                const dbAway = this.normalize(match.teamB);
                const dbTime = new Date(match.startTime).getTime();

                const teamsMatch = (dbHome === apiHome && dbAway === apiAway) || (dbHome === apiAway && dbAway === apiHome);

                if (teamsMatch) {
                    const timeDiff = apiTime > 0 ? Math.abs(dbTime - apiTime) / (1000 * 60 * 60) : 0;
                    if (timeDiff <= 12 || apiTime === 0) {
                        this.eventToMatchId.set(eventId, match.matchId);
                        console.log(`[OddsApiLive] 🔗 Linked ${metadata.home} v ${metadata.away} → match ${match.matchId}`);
                        return match.matchId;
                    }
                }
            }
        } catch (err) {
            console.error(`[OddsApiLive] ❌ Event linking error for ${eventId}:`, err.message);
        }
        return null;
    }

    normalize(name) {
        if (!name) return '';
        let n = name.toLowerCase().trim();
        n = n.replace(/\bwomen\b/g, '').replace(/\bw\b/g, '').replace(/\bteam\b/g, '')
             .replace(/\bcricket\b/g, '').replace(/\bnational\b/g, '')
             .replace(/\bmen\b/g, '').replace(/\bxi\b/g, '');
        n = n.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '');

        const aliases = {
            'royalchallengers': 'rcb', 'bengaluru': 'rcb', 'bangalore': 'rcb',
            'lucknow': 'lsg', 'sunrisers': 'srh', 'hyderabad': 'srh',
            'mumbaiindians': 'mi', 'mumbai': 'mi', 'chennaisuperkings': 'csk',
            'chennai': 'csk', 'delhicapitals': 'dc', 'delhi': 'dc',
            'rajasthanroyals': 'rr', 'rajasthan': 'rr', 'gujarattitans': 'gt',
            'gujarat': 'gt', 'kolkataknightriders': 'kkr', 'kolkata': 'kkr',
            'punjabkings': 'pbks', 'kingsxi': 'pbks', 'punjab': 'pbks'
        };
        for (const [key, value] of Object.entries(aliases)) {
            if (n.includes(key)) return value;
        }
        return n;
    }

    async handleOddsData(msg) {
        // msg contains { id, home, away, bookie, markets } or similar from websocket
        // Also handling REST payload which might be { id, bookmakers: [{ key: bookie, markets }] }
        const eventId = msg.id;
        if (!eventId) return;

        this.storeFixtureMetadata(msg);
        
        let matchId = this.eventToMatchId.get(eventId);
        if (!matchId) {
            matchId = await this.linkEventToMatch(eventId);
            if (!matchId) return;
        }

        await this.processOddsForEvent(msg);
    }

    async processOddsForEvent(eventObj) {
        const eventId = eventObj.id || eventObj.eventId;
        const matchId = this.eventToMatchId.get(eventId);
        if (!matchId) return;

        const metadata = this.eventMetadata.get(eventId);
        if (!metadata) return;

        // WebSocket gives { bookie, markets } directly, REST gives { bookmakers: [ {key, markets} ] }
        let bookies = [];
        if (eventObj.bookie && eventObj.markets) {
            bookies.push({ key: eventObj.bookie, markets: eventObj.markets });
        } else if (eventObj.bookmakers) {
            bookies = eventObj.bookmakers;
        }

        // Find best odds among targeted bookmakers
        let bestHomePrice = 0;
        let bestAwayPrice = 0;
        let usedBookie = '';

        for (const b of bookies) {
            if (!BOOKMAKERS.includes(b.key)) continue;

            const h2h = (b.markets || []).find(m => m.key === 'h2h');
            if (h2h && h2h.outcomes) {
                // Find outcomes matching home/away names
                let homeOutcome = h2h.outcomes.find(o => this.normalize(o.name) === this.normalize(metadata.home));
                let awayOutcome = h2h.outcomes.find(o => this.normalize(o.name) === this.normalize(metadata.away));

                if (!homeOutcome || !awayOutcome) {
                    // Fallback to order if names don't match cleanly
                    if (h2h.outcomes.length >= 2) {
                        homeOutcome = h2h.outcomes[0];
                        awayOutcome = h2h.outcomes[1];
                    }
                }

                if (homeOutcome && awayOutcome) {
                    // Check if this bookie's price is better, or if it's our first valid price
                    if (homeOutcome.price > bestHomePrice || !usedBookie) {
                        bestHomePrice = homeOutcome.price;
                        bestAwayPrice = awayOutcome.price;
                        usedBookie = b.key;
                    }
                }
            }
        }

        if (bestHomePrice === 0 || bestAwayPrice === 0) return;

        // odds-api.io gives decimal prices.
        const homeBack = bestHomePrice;
        const awayBack = bestAwayPrice;
        // Synthesize lay
        const homeLay = Number((homeBack + 0.01).toFixed(2));
        const awayLay = Number((awayBack + 0.01).toFixed(2));

        let needsSwap = false;
        if (this.swapCache.has(matchId)) {
            needsSwap = this.swapCache.get(matchId);
        } else {
            try {
                const dbMatch = await Match.findOne({ matchId });
                if (dbMatch) {
                    const dbTeamA = this.normalize(dbMatch.teamA);
                    const apiHome = this.normalize(metadata.home);
                    const apiAway = this.normalize(metadata.away);

                    if (dbTeamA === apiAway && dbTeamA !== apiHome) {
                        needsSwap = true;
                    }
                }
                // Cache the swap decision so we don't hit the DB again for this match
                this.swapCache.set(matchId, needsSwap);
            } catch (err) {}
        }

        const teamABack = needsSwap ? awayBack : homeBack;
        const teamALay = needsSwap ? awayLay : homeLay;
        const teamBBack = needsSwap ? homeBack : awayBack;
        const teamBLay = needsSwap ? homeLay : awayLay;

        const depthBackA = '100'; const depthLayA = '100';
        const depthBackB = '100'; const depthLayB = '100';

        const now = new Date();
        const oddsPayload = {
            matchId,
            teamABack, teamALay, teamBBack, teamBLay,
            depthBackA, depthLayA, depthBackB, depthLayB,
            bookmaker: usedBookie,
            isLive: metadata.isLive,
            updatedAt: now
        };

        const cached = this.oddsCache.get(matchId);
        const changed = !cached ||
            cached.teamABack !== oddsPayload.teamABack || cached.teamALay !== oddsPayload.teamALay ||
            cached.teamBBack !== oddsPayload.teamBBack || cached.teamBLay !== oddsPayload.teamBLay;

        if (!changed) return;

        this.oddsCache.set(matchId, oddsPayload);

        const dbTeamAName = needsSwap ? metadata.away : metadata.home;
        const dbTeamBName = needsSwap ? metadata.home : metadata.away;

        if (this.io) {
            this.io.emit('market_odds_update', {
                matchId,
                updatedAt: now,
                marketStatus: 'OPEN',
                runners: [
                    { name: dbTeamAName, back: teamABack, lay: teamALay, depthBack: depthBackA, depthLay: depthLayA },
                    { name: dbTeamBName, back: teamBBack, lay: teamBLay, depthBack: depthBackB, depthLay: depthLayB }
                ]
            });
        }

        this.writeQueue.set(matchId, {
            ...oddsPayload,
            oddsApiEventId: eventId,
            teamA: dbTeamAName,
            teamB: dbTeamBName,
            marketStatus: 'OPEN'
        });
    }

    async handleDeleted(msg) {
        const eventId = msg.id;
        if (!eventId) return;
        const matchId = this.eventToMatchId.get(eventId);
        if (!matchId) return;

        if (this.io) {
            this.io.emit('market_odds_update', { matchId, marketStatus: 'SUSPENDED' });
        }
        await this.updateMarketStatus(matchId, 'SUSPENDED');
    }

    handleScoreUpdate(msg) {
        // Implement if required
    }

    handleStatusUpdate(msg) {
        const eventId = msg.id;
        if (!eventId) return;
        const matchId = this.eventToMatchId.get(eventId);
        if (!matchId) return;

        const metadata = this.eventMetadata.get(eventId);
        if (metadata) {
            metadata.isLive = (msg.status === 'live');
        }
    }

    async updateMarketStatus(matchId, status) {
        try {
            await MarketOdds.findOneAndUpdate({ matchId }, { marketStatus: status, updatedAt: new Date() });
            await Match.findOneAndUpdate({ matchId }, { marketStatus: status, lastUpdated: new Date() });
        } catch (err) {}
    }

    async flushWriteQueue() {
        if (this.writeQueue.size === 0) return;
        const updates = Array.from(this.writeQueue.values());
        this.writeQueue.clear();

        const marketOddsOps = updates.map(update => ({
            updateOne: {
                filter: { matchId: update.matchId },
                update: {
                    $set: {
                        matchId: update.matchId,
                        oddsApiEventId: update.oddsApiEventId || '',
                        teamA: { back: update.teamABack, lay: update.teamALay },
                        teamB: { back: update.teamBBack, lay: update.teamBLay },
                        bookmaker: update.bookmaker,
                        marketStatus: update.marketStatus,
                        updatedAt: update.updatedAt
                    }
                },
                upsert: true
            }
        }));

        const oddsMarketOps = updates.map(update => ({
            updateOne: {
                filter: { sportmonksMatchId: update.matchId },
                update: {
                    $set: {
                        sportmonksMatchId: update.matchId,
                        oddsApiEventId: update.oddsApiEventId || '',
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
                    }
                },
                upsert: true
            }
        }));

        const matchOps = updates.map(update => ({
            updateOne: {
                filter: { matchId: update.matchId },
                update: {
                    $set: {
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
                }
            }
        }));

        try {
            if (marketOddsOps.length > 0) await MarketOdds.bulkWrite(marketOddsOps);
            if (oddsMarketOps.length > 0) await OddsMarket.bulkWrite(oddsMarketOps);
            if (matchOps.length > 0) await Match.bulkWrite(matchOps);
        } catch (err) {
            console.error('[OddsApiLive] Bulk write error:', err.message);
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
        } catch (err) {}
    }

    async pollLinkedFixtures() {
        try {
            const liveMatches = await Match.find({ status: 'live' });
            if (liveMatches.length === 0) return;

            for (const [eventId, matchId] of this.eventToMatchId.entries()) {
                const isLive = liveMatches.some(m => m.matchId === matchId);
                if (!isLive) continue;

                try {
                    const oddsData = await oddsApiRest.getFixtureOdds(eventId);
                    if (oddsData && Array.isArray(oddsData)) {
                        for (const odd of oddsData) {
                            await this.processOddsForEvent(odd);
                        }
                    }
                } catch (err) {}
            }
        } catch (err) {}
    }

    async pollUpcomingFixtures() {
        try {
            const upcomingMatches = await Match.find({ status: 'upcoming' });
            if (upcomingMatches.length === 0) return;

            const upcomingMatchIds = new Set(upcomingMatches.map(m => m.matchId));
            for (const [eventId, matchId] of this.eventToMatchId.entries()) {
                if (!upcomingMatchIds.has(matchId)) continue;

                try {
                    const oddsData = await oddsApiRest.getFixtureOdds(eventId);
                    if (oddsData && Array.isArray(oddsData)) {
                        for (const odd of oddsData) {
                            await this.processOddsForEvent(odd);
                        }
                    }
                } catch (err) {}
            }

            const unlinkedUpcoming = upcomingMatches.filter(
                m => !Array.from(this.eventToMatchId.values()).includes(m.matchId)
            );
            if (unlinkedUpcoming.length > 0) {
                await this.bootstrapUpcomingFixtures();
            }
        } catch (err) {}
    }

    async fetchOddsSnapshot() {
        console.log('[OddsApiLive] 📸 Fetching odds snapshot via REST...');
        try {
            const fixtures = await oddsApiRest.getFixturesToday();
            if (fixtures && Array.isArray(fixtures)) {
                for (const fixture of fixtures) {
                    if (fixture.id) {
                        this.storeFixtureMetadata(fixture);
                        try {
                            const oddsData = await oddsApiRest.getFixtureOdds(fixture.id);
                            if (oddsData && Array.isArray(oddsData)) {
                                for (const odd of oddsData) {
                                    await this.processOddsForEvent(odd);
                                }
                            }
                        } catch (err) {}
                    }
                }
            }
        } catch (err) {
            console.error('[OddsApiLive] ❌ REST snapshot failed:', err.message);
        }
    }

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

module.exports = new OddsApiLiveService();
