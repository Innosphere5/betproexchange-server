const WebSocket = require('ws');
const Match = require('../models/Match');
const OddsMarket = require('../models/OddsMarket');
const oddsApiRest = require('./oddsApiRest');
require('dotenv').config();

// CONFIGURATION
const API_KEY = process.env.ODDS_API_KEY || '6de1aca2c07d3f5abeb411b7157069e6';
const WS_URL = 'wss://v5.oddspapi.io/ws';
const ALLOWED_BOOKMAKERS = ['pinnacle', 'betfair_ex'];

class OddsWebsocketService {
    constructor() {
        this.ws = null;
        this.io = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.maxReconnectDelay = 30000;
        this.wsDisabled = false;
        
        this.cache = new Map();
        this.eventMapping = new Map();
        this.eventMetadata = new Map(); // Store fixture details
        
        this.writeQueue = new Map();
        this.writeInterval = setInterval(() => this.flushWriteQueue(), 1000);
        this.lastSeq = null;
    }

    init(io) {
        this.io = io;
        this.connect();
    }

    async initSnapshot() {
        try {
            console.log('[OddsWS] 📸 Fetching initial events snapshot via oddsApiRest...');
            const data = await oddsApiRest.getFixturesToday();
            if (Array.isArray(data)) {
                for (const fixture of data) {
                    const eventId = fixture.fixtureId || fixture.id;
                    if (!eventId) continue;
                    
                    const home = fixture.participants?.participant1Name || fixture.home_team || fixture.home;
                    const away = fixture.participants?.participant2Name || fixture.away_team || fixture.away;
                    
                    this.eventMetadata.set(eventId, {
                        eventId: eventId,
                        home: home,
                        away: away,
                        isLive: fixture.status?.live || fixture.status === 'live'
                    });
                    
                    const dbMatch = await this.matchOddsEventToSportMonksFixture(eventId, home, away);
                    if (dbMatch) {
                        this.eventMapping.set(eventId, dbMatch.matchId);
                        console.log(`[OddsWS] 🔗 Pre-linked ${home} v ${away} (ID: ${eventId}) -> Match ${dbMatch.matchId}`);
                    }
                }
            }
        } catch (err) {
            console.error('[OddsWS] ❌ Snapshot fetch failed:', err.message);
        }
    }

    connect() {
        if (!API_KEY) {
            console.error('[OddsWS] ❌ Missing ODDS_API_KEY');
            return;
        }
        if (this.wsDisabled) return;

        console.log('[OddsWS] 🔄 Connecting to OddsPapi WebSocket...');
        this.ws = new WebSocket(WS_URL);

        this.ws.on('open', () => {
            console.log('✅ [OddsWS] WebSocket Connected. Authenticating...');
            this.reconnectAttempts = 0;
            const loginPayload = {
                type: 'login',
                apiKey: API_KEY,
                channels: ['fixtures', 'odds'],
                receiveType: 'json'
            };
            if (this.lastSeq) {
                loginPayload.serverEpoch = this.lastSeq;
            }
            this.ws.send(JSON.stringify(loginPayload));
        });

        this.ws.on('message', (data) => {
            const str = data.toString();
            const lines = str.split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const message = JSON.parse(line);
                    this.handleMessage(message);
                } catch (err) {
                    console.error('[OddsWS] Error parsing message line:', err.message, '| Line:', line.substring(0, 50));
                }
            }
        });

        this.ws.on('close', () => {
            console.warn('[OddsWS] ⚠️ WebSocket Closed. Reconnecting...');
            this.reconnect();
        });

        this.ws.on('error', (err) => {
            console.error('[OddsWS] ❌ WebSocket Error:', err.message);
        });
    }

    reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn('[OddsWS] ⛔ Max reconnect attempts reached. Waiting longer...');
        }
        const delay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, this.maxReconnectDelay);
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), delay);
    }

    async handleMessage(msg) {
        if (!msg) return;
        if (msg.serverEpoch) {
            this.lastSeq = msg.serverEpoch;
        }

        const type = msg.type || msg.channel;

        switch (type) {
            case 'login_ok':
                console.log('[OddsWS] ✅ Login successful. Initializing snapshot...');
                this.initSnapshot();
                break;
            case 'fixtures':
                this.storeFixtureMetadata(msg);
                break;
            case 'odds':
                await this.processOddsEvent(msg);
                break;
            case 'deleted':
                this.handleDeleted(msg);
                break;
            case 'snapshot_required':
                console.warn('[OddsWS] 🔄 Snapshot required from server. Resetting state.');
                this.lastSeq = null;
                this.initSnapshot();
                break;
            default:
                break;
        }
    }

    storeFixtureMetadata(fixture) {
        const eventId = fixture.fixtureId || fixture.id;
        if (!eventId) return;

        const home = fixture.participants?.participant1Name || fixture.home_team || fixture.home;
        const away = fixture.participants?.participant2Name || fixture.away_team || fixture.away;
        
        this.eventMetadata.set(eventId, {
            eventId: eventId,
            home: home,
            away: away,
            isLive: fixture.status?.live || fixture.status === 'live'
        });
    }

    async processOddsEvent(event) {
        const eventId = event.fixtureId || event.id;
        if (!eventId) return;

        try {
            let sportmonksMatchId = this.eventMapping.get(eventId);
            const meta = this.eventMetadata.get(eventId);
            
            if (!sportmonksMatchId && meta && meta.home && meta.away) {
                const dbMatch = await this.matchOddsEventToSportMonksFixture(eventId, meta.home, meta.away);
                if (dbMatch) {
                    sportmonksMatchId = dbMatch.matchId;
                    this.eventMapping.set(eventId, sportmonksMatchId);
                    console.log(`[OddsWS] 🔗 Linked event ${meta.home} v ${meta.away} to match ${sportmonksMatchId}`);
                }
            }

            if (!sportmonksMatchId || !meta) return;

            // OddsPapi Odds Payload extraction (targeting Market 271 for match winner)
            let bookiesMap = event.bookmakers || {};
            let bestHomePrice = 0;
            let bestAwayPrice = 0;
            let selectedBM = '';

            for (const [bookieKey, outcomes] of Object.entries(bookiesMap)) {
                if (!ALLOWED_BOOKMAKERS.includes(bookieKey)) continue;

                // 271=Home, 272=Away
                const homeOutcome = outcomes['271'];
                const awayOutcome = outcomes['272'];

                if (homeOutcome && awayOutcome && homeOutcome.price && awayOutcome.price) {
                    if (homeOutcome.price > bestHomePrice || !selectedBM) {
                        bestHomePrice = homeOutcome.price;
                        bestAwayPrice = awayOutcome.price;
                        selectedBM = bookieKey;
                    }
                }
            }

            if (bestHomePrice === 0 || bestAwayPrice === 0) return;

            const processRunner = (backPrice) => {
                const b = Number(backPrice);
                const spread = 0.01;
                const l = Number((b + spread).toFixed(2));
                const db = "100";
                const dl = (Math.random() * 500 + 100).toFixed(0);
                return { back: b, lay: l, depthBack: db, depthLay: dl };
            };

            const teamA_odds = processRunner(bestHomePrice);
            const teamB_odds = processRunner(bestAwayPrice);

            const payload = {
                matchId: sportmonksMatchId,
                teamABack: teamA_odds.back,
                teamALay: teamA_odds.lay,
                teamBBack: teamB_odds.back,
                teamBLay: teamB_odds.lay,
                depthBackA: teamA_odds.depthBack,
                depthLayA: teamA_odds.depthLay,
                depthBackB: teamB_odds.depthBack,
                depthLayB: teamB_odds.depthLay,
                updatedAt: new Date()
            };

            const cached = this.cache.get(sportmonksMatchId);
            const oddsChanged = !cached || 
                cached.teamABack !== payload.teamABack || 
                cached.teamALay !== payload.teamALay ||
                cached.teamBBack !== payload.teamBBack ||
                cached.teamBLay !== payload.teamBLay;

            if (oddsChanged) {
                this.cache.set(sportmonksMatchId, payload);
                
                if (this.io) {
                    this.io.emit('market_odds_update', {
                        matchId: sportmonksMatchId,
                        updatedAt: payload.updatedAt,
                        marketStatus: 'OPEN',
                        runners: [
                            { 
                                name: meta.home || '', 
                                back: payload.teamABack, 
                                lay: payload.teamALay,
                                depthBack: payload.depthBackA,
                                depthLay: payload.depthLayA
                            },
                            { 
                                name: meta.away || '', 
                                back: payload.teamBBack, 
                                lay: payload.teamBLay,
                                depthBack: payload.depthBackB,
                                depthLay: payload.depthLayB
                            }
                        ]
                    });
                }

                this.writeQueue.set(sportmonksMatchId, {
                    ...payload,
                    oddsApiEventId: eventId,
                    teamA: meta.home,
                    teamB: meta.away,
                    bookmaker: selectedBM,
                    marketStatus: 'OPEN',
                    isLive: meta.isLive
                });
            }
        } catch (err) {
            console.error(`[OddsWS] Error processing odds for event ${eventId}:`, err.message);
        }
    }

    handleDeleted(msg) {
        const eventId = msg.fixtureId || msg.id || msg;
        const matchId = this.eventMapping.get(eventId);
        if (matchId) {
            if (this.io) {
                this.io.emit('market_odds_update', { matchId, marketStatus: 'SUSPENDED' });
            }
            this.eventMapping.delete(eventId);
            this.cache.delete(matchId);
        }
    }

    async flushWriteQueue() {
        if (this.writeQueue.size === 0) return;

        const updates = Array.from(this.writeQueue.values());
        this.writeQueue.clear();

        for (const update of updates) {
            try {
                await OddsMarket.findOneAndUpdate(
                    { sportmonksMatchId: update.matchId },
                    update,
                    { upsert: true }
                );

                await Match.findOneAndUpdate(
                    { matchId: update.matchId },
                    {
                        backOddsA: update.teamABack,
                        layOddsA: update.teamALay,
                        backOddsB: update.teamBBack,
                        layOddsB: update.teamBLay,
                        marketStatus: update.marketStatus,
                        lastUpdated: update.updatedAt
                    }
                );
            } catch (err) {
                console.error(`[OddsWS] DB Update Error for ${update.matchId}:`, err.message);
            }
        }
    }

    async matchOddsEventToSportMonksFixture(eventId, apiHomeName, apiAwayName) {
        const matches = await Match.find({ 
            status: { $in: ['live', 'upcoming'] }
        });

        const normalize = (name) => {
            if (!name) return "";
            let n = name.toLowerCase().trim();

            n = n.replace(/\bwomen\b/g, "");
            n = n.replace(/\bw\b/g, "");
            n = n.replace(/\bteam\b/g, "");
            n = n.replace(/\bcricket\b/g, "");
            n = n.replace(/\bnational\b/g, "");
            n = n.replace(/\bmen\b/g, "");
            n = n.replace(/\bxi\b/g, "");

            n = n.replace(/[^a-z0-9\s]/g, ""); 
            n = n.replace(/\s+/g, ""); 
            
            const aliases = {
                "royalchallengers": "rcb", "bengaluru": "rcb", "bangalore": "rcb",
                "lucknow": "lsg", "sunrisers": "srh", "hyderabad": "srh",
                "mumbaiindians": "mi", "mumbai": "mi", "chennaisuperkings": "csk",
                "chennai": "csk", "delhicapitals": "dc", "delhi": "dc",
                "rajasthanroyals": "rr", "rajasthan": "rr", "gujarattitans": "gt",
                "gujarat": "gt", "kolkataknightriders": "kkr", "kolkata": "kkr",
                "punjabkings": "pbks", "kingsxi": "pbks", "punjab": "pbks"
            };
            
            for (const [key, value] of Object.entries(aliases)) {
                if (n.includes(key)) return value;
            }
            return n;
        };

        const apiHome = normalize(apiHomeName);
        const apiAway = normalize(apiAwayName);

        for (const match of matches) {
            const dbHome = normalize(match.teamA);
            const dbAway = normalize(match.teamB);

            const teamsMatch = (dbHome === apiHome && dbAway === apiAway) || 
                               (dbHome === apiAway && dbAway === apiHome);

            if (teamsMatch) {
                return match;
            }
        }
        return null;
    }
}

module.exports = new OddsWebsocketService();
