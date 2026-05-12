const WebSocket = require('ws');
const Match = require('../models/Match');
const OddsMarket = require('../models/OddsMarket');
require('dotenv').config();

// CONFIGURATION
const API_KEY = process.env.ODDS_API_KEY;
const WS_URL = `wss://api.odds-api.io/v3/ws?apiKey=${API_KEY}&sport=cricket&markets=ML&status=live&status=prematch`;
const ALLOWED_BOOKMAKERS = ['Betfair Exchange', 'Bet365', 'Stake', '1xBet', 'SBOBET'];

class OddsWebsocketService {
    constructor() {
        this.ws = null;
        this.io = null;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000; // 30 seconds
        this.cache = new Map(); // matchId -> { odds, timestamp }
        this.eventMapping = new Map(); // oddsApiEventId -> sportmonksMatchId
        this.writeQueue = new Map(); // matchId -> updateData
        this.writeInterval = setInterval(() => this.flushWriteQueue(), 1000); // Throttle DB writes to every 1 second
    }

    init(io) {
        this.io = io;
        this.initSnapshot();
        this.connect();
    }

    async initSnapshot() {
        try {
            const oddsApiService = require('./oddsApiService');
            console.log('[OddsWS] 📸 Fetching initial events snapshot...');
            const data = await oddsApiService.fetch('events', { sport: 'cricket', status: 'live,pending' });
            if (Array.isArray(data)) {
                for (const event of data) {
                    // We just need to build the mapping, no need to process odds here
                    // as the WebSocket will send the first update soon.
                    // But if we want to show odds immediately, we can fetch them.
                    const sportmonksMatchId = await this.matchOddsEventToSportMonksFixture(event);
                    if (sportmonksMatchId) {
                        this.eventMapping.set(event.id, sportmonksMatchId);
                        console.log(`[OddsWS] 🔗 Pre-linked ${event.home} v ${event.away} (ID: ${event.id})`);
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

        console.log('[OddsWS] 🔄 Connecting to Odds-API WebSocket...');
        this.ws = new WebSocket(WS_URL);

        this.ws.on('open', () => {
            console.log('✅ [OddsWS] WebSocket Connected');
            this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data) => {
            const str = data.toString();
            // Some providers send multiple JSON objects separated by newlines in one frame
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
        const delay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, this.maxReconnectDelay);
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), delay);
    }

    async handleMessage(msg) {
        if (!msg) return;
        const { type } = msg;

        switch (type) {
            case 'welcome':
                console.log('[OddsWS] 👋 Received Welcome:', msg.message);
                // After welcome, we could fetch initial snapshot if needed, 
                // but the feed should start sending 'created' or 'updated' messages.
                break;
            case 'created':
            case 'updated':
                // Check if it's the new flat format (msg is the event) or old nested format (msg.data is the event)
                const data = msg.data || msg; 
                
                if (Array.isArray(data)) {
                    for (const event of data) {
                        if (event) await this.processEvent(event);
                    }
                } else {
                    await this.processEvent(data);
                }
                break;
            case 'deleted':
                this.handleDeleted(msg.data || msg);
                break;
            default:
                break;
        }
    }

    async processEvent(event) {
        if (!event || !event.id) return;

        try {
            // 1. Validate Markets
            // The flat format has 'markets' array, not 'bookmakers' object
            let mlMarket = null;
            let selectedBM = event.bookie || 'Unknown';

            if (event.markets && Array.isArray(event.markets)) {
                mlMarket = event.markets.find(m => m.name === 'ML' || m.name === 'Match Winner' || m.name === 'h2h');
            } else if (event.bookmakers) {
                // Handle nested format if it still exists
                for (const bmName of ALLOWED_BOOKMAKERS) {
                    if (event.bookmakers[bmName]) {
                        const found = event.bookmakers[bmName].find(m => m.name === 'ML' || m.name === 'Match Winner' || m.name === 'h2h');
                        if (found) {
                            mlMarket = found;
                            selectedBM = bmName;
                            break;
                        }
                    }
                }
            }

            if (!mlMarket || !mlMarket.odds || !mlMarket.odds[0]) return;

            // 2. Match with SportMonks Fixture
            let sportmonksMatchId = this.eventMapping.get(event.id);
            
            if (!sportmonksMatchId) {
                // If home/away are missing (common in flat updates), we can't link yet unless we have them from a previous 'created' message or REST.
                if (!event.home || !event.away) {
                    // Try to fetch event details via REST if not linked yet
                    // For now, we skip to avoid spamming REST, but in production we'd have a snapshot.
                    return;
                }

                const dbMatch = await this.matchOddsEventToSportMonksFixture(event);
                if (!dbMatch) return;
                
                sportmonksMatchId = dbMatch.matchId;
                this.eventMapping.set(event.id, sportmonksMatchId);
                console.log(`[OddsWS] 🔗 Linked event ${event.home} v ${event.away} to match ${sportmonksMatchId}`);
            }

            // 3. Parse Odds
            const oddsData = mlMarket.odds[0];
            const isLive = event.status === 'live';
            
            // BACK/LAY LOGIC
            const processRunner = (back, lay) => {
                const b = Number(back);
                let l = Number(lay);
                if (isNaN(l) || !l) {
                    const spread = isLive ? 0.02 : 0.01;
                    l = Number((b + spread).toFixed(2));
                }
                return { back: b, lay: l };
            };

            const teamA_odds = processRunner(oddsData.home, oddsData.layHome);
            const teamB_odds = processRunner(oddsData.away, oddsData.layAway);

            const payload = {
                matchId: sportmonksMatchId,
                teamABack: teamA_odds.back,
                teamALay: teamA_odds.lay,
                teamBBack: teamB_odds.back,
                teamBLay: teamB_odds.lay,
                updatedAt: new Date()
            };

            // 4. Check Cache to prevent duplicate UI updates
            const cached = this.cache.get(sportmonksMatchId);
            const oddsChanged = !cached || 
                cached.teamABack !== payload.teamABack || 
                cached.teamALay !== payload.teamALay ||
                cached.teamBBack !== payload.teamBBack ||
                cached.teamBLay !== payload.teamBLay;

            if (oddsChanged) {
                this.cache.set(sportmonksMatchId, payload);
                
                // Emit to UI instantly via Socket.IO (Matching Frontend Format)
                if (this.io) {
                    this.io.emit('market_odds_update', {
                        matchId: sportmonksMatchId,
                        updatedAt: payload.updatedAt,
                        runners: [
                            { name: event.home, back: payload.teamABack, lay: payload.teamALay },
                            { name: event.away, back: payload.teamBBack, lay: payload.teamBLay }
                        ]
                    });
                }

                // Queue for DB write
                this.writeQueue.set(sportmonksMatchId, {
                    ...payload,
                    oddsApiEventId: event.id,
                    teamA: event.home,
                    teamB: event.away,
                    bookmaker: selectedBM,
                    marketStatus: 'OPEN',
                    isLive: isLive
                });
            }
        } catch (err) {
            console.error(`[OddsWS] Error processing event ${event.id}:`, err.message);
        }
    }

    handleDeleted(data) {
        const eventId = data.id || data;
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
                // Update OddsMarket collection
                await OddsMarket.findOneAndUpdate(
                    { sportmonksMatchId: update.matchId },
                    update,
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
                        lastUpdated: update.updatedAt
                    }
                );
            } catch (err) {
                console.error(`[OddsWS] DB Update Error for ${update.matchId}:`, err.message);
            }
        }
    }

    // MATCHING LOGIC
    async matchOddsEventToSportMonksFixture(apiEvent) {
        const matches = await Match.find({ 
            status: { $in: ['live', 'upcoming'] }
        });

        const normalize = (name) => {
            if (!name) return "";
            let n = name.toLowerCase().trim();
            n = n.replace(/[^a-z0-9\s]/g, ""); 
            n = n.replace(/\s+/g, ""); 
            
            const aliases = {
                "royalchallengers": "rcb",
                "bengaluru": "rcb",
                "bangalore": "rcb",
                "lucknow": "lsg",
                "sunrisers": "srh",
                "mumbaiindians": "mi",
                "chennaisuperkings": "csk",
                "delhicapitals": "dc",
                "rajasthanroyals": "rr",
                "gujarattitans": "gt",
                "kolkataknightriders": "kkr",
                "punjabkings": "pbks"
            };
            
            for (const [key, value] of Object.entries(aliases)) {
                if (n.includes(key)) return value;
            }
            return n;
        };

        const apiHome = normalize(apiEvent.home);
        const apiAway = normalize(apiEvent.away);
        const apiTime = new Date(apiEvent.date).getTime();

        for (const match of matches) {
            const dbHome = normalize(match.teamA);
            const dbAway = normalize(match.teamB);
            const dbTime = new Date(match.startTime).getTime();

            const teamsMatch = (dbHome === apiHome && dbAway === apiAway) || 
                               (dbHome === apiAway && dbAway === apiHome);

            if (teamsMatch) {
                const timeDiff = Math.abs(dbTime - apiTime) / (1000 * 60 * 60);
                if (timeDiff <= 12) { 
                    return match;
                }
            }
        }
        return null;
    }
}

module.exports = new OddsWebsocketService();
