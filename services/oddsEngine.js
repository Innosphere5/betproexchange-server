const axios = require('axios');
const Match = require('../models/Match');
const MarketOdds = require('../models/MarketOdds');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY?.trim();
const BASE_URL = 'https://api.odds-api.io/v3';

// ALLOWED BOOKMAKERS FOR THIS STARTER PLAN KEY
const ALLOWED_BOOKMAKERS = 'SingBet,Betfair Exchange,Bet365,1xbet,Stake';

let ioInstance = null;
const STALE_TIMEOUT_MS = 60000;

// ─── Normalization & Mapping ───────────────────────────────────────────────────

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

async function findMatchesForEvent(apiEvent) {
    const matches = await Match.find({ 
        status: { $in: ['live', 'upcoming'] }
    });

    const results = [];
    for (const match of matches) {
        const dbHome = normalize(match.teamA);
        const dbAway = normalize(match.teamB);
        const apiHome = normalize(apiEvent.home);
        const apiAway = normalize(apiEvent.away);

        const teamsMatch = (dbHome === apiHome && dbAway === apiAway) || 
                           (dbHome === apiAway && dbAway === apiHome);

        if (teamsMatch) {
            const dbTime = new Date(match.startTime).getTime();
            const apiTime = new Date(apiEvent.date).getTime();
            const timeDiff = Math.abs(dbTime - apiTime) / (1000 * 60 * 60);
            if (timeDiff <= 12) { 
                results.push(match);
            }
        }
    }
    return results;
}

// ─── Back/Lay Logic ────────────────────────────────────────────────────────────

function getSpread(isLive) {
    return isLive ? 0.03 : 0.01;
}

function processRunnerOdds(back, lay, isLive) {
    const b = Number(back);
    if (lay) {
        return { back: b, lay: Number(lay) };
    }
    const spread = getSpread(isLive);
    return {
        back: b,
        lay: Number((b + spread).toFixed(2))
    };
}

// ─── Core Engine ───────────────────────────────────────────────────────────────

async function handleOddsUpdate(eventData) {
    try {
        const { id, home, away, date, status, bookmakers } = eventData;
        const isLive = status === 'live';

        const dbMatches = await findMatchesForEvent(eventData);
        if (dbMatches.length === 0) return;

        for (const dbMatch of dbMatches) {
            // Store mapping
            await MarketOdds.findOneAndUpdate(
                { matchId: dbMatch.matchId },
                { oddsApiEventId: id, updatedAt: new Date() },
                { upsert: true }
            );

            if (!bookmakers) continue;

            // Find best bookmaker that HAS ML market
            const preferred = ALLOWED_BOOKMAKERS.split(',');
            let selectedBM = null;
            let mlMarket = null;

            for (const bmName of preferred) {
                if (bookmakers[bmName]) {
                    const found = bookmakers[bmName].find(m => m.name === 'ML' || m.name === 'Match Winner');
                    if (found && found.odds && found.odds[0]) {
                        selectedBM = bmName;
                        mlMarket = found;
                        break;
                    }
                }
            }

            // Fallback to first available BM with ML if preferred ones don't have it
            if (!mlMarket) {
                for (const bmName in bookmakers) {
                    const found = bookmakers[bmName].find(m => m.name === 'ML' || m.name === 'Match Winner');
                    if (found && found.odds && found.odds[0]) {
                        selectedBM = bmName;
                        mlMarket = found;
                        break;
                    }
                }
            }
            
            if (!mlMarket) {
                console.log(`[Odds Engine] ⚠️ No ML market found for ${dbMatch.teamA} v ${dbMatch.teamB}`);
                continue;
            }

            const oddsData = mlMarket.odds[0];
            const teamA_odds = processRunnerOdds(oddsData.home, oddsData.layHome, isLive);
            const teamB_odds = processRunnerOdds(oddsData.away, oddsData.layAway, isLive);

            const updateData = {
                matchId: dbMatch.matchId,
                oddsApiEventId: id,
                teamA: teamA_odds,
                teamB: teamB_odds,
                bookmaker: selectedBM,
                marketStatus: 'OPEN',
                updatedAt: new Date()
            };

            await MarketOdds.findOneAndUpdate({ matchId: dbMatch.matchId }, updateData, { upsert: true });

            // Update Match document
            await Match.findOneAndUpdate(
                { matchId: dbMatch.matchId },
                { 
                    backOddsA: teamA_odds.back, 
                    layOddsA: teamA_odds.lay, 
                    backOddsB: teamB_odds.back, 
                    layOddsB: teamB_odds.lay,
                    marketStatus: 'OPEN',
                    lastUpdated: new Date()
                }
            );

            console.log(`[Odds Engine] ✅ Odds updated for ${dbMatch.teamA} v ${dbMatch.teamB} via ${selectedBM}`);

            if (ioInstance) {
                ioInstance.emit('market_odds_update', {
                    matchId: dbMatch.matchId,
                    runners: [
                        { name: dbMatch.teamA, back: teamA_odds.back, lay: teamA_odds.lay },
                        { name: dbMatch.teamB, back: teamB_odds.back, lay: teamB_odds.lay }
                    ],
                    marketStatus: 'OPEN',
                    updatedAt: updateData.updatedAt
                });
            }
        }
    } catch (err) {
        console.error('[Odds Engine] Error in handleOddsUpdate:', err.message);
    }
}

async function updateMarketStatus(matchId, status) {
    await MarketOdds.findOneAndUpdate({ matchId }, { marketStatus: status, updatedAt: new Date() });
    await Match.findOneAndUpdate({ matchId }, { marketStatus: status, lastUpdated: new Date() });
    if (ioInstance) {
        ioInstance.emit('market_odds_update', { matchId, marketStatus: status });
    }
}

// ─── REST Polling ─────────────────────────────────────────────────────────────

async function pollAllActiveOdds() {
    try {
        const activeMatches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
        if (activeMatches.length === 0) return;

        const oddsMarkets = await MarketOdds.find({ matchId: { $in: activeMatches.map(m => m.matchId) } });
        
        for (const market of oddsMarkets) {
            if (!market.oddsApiEventId) continue;

            const match = activeMatches.find(m => m.matchId === market.matchId);
            if (!match) continue;

            const now = Date.now();
            const lastUpdate = new Date(market.updatedAt).getTime();
            const isLive = match.status === 'live';
            const waitTime = isLive ? 5000 : 30000; 

            if (now - lastUpdate < waitTime) continue;

            console.log(`[Odds Engine] 🔄 Polling ${match.status} odds for ${match.teamA} v ${match.teamB}...`);
            try {
                const response = await axios.get(`${BASE_URL}/odds`, {
                    params: { 
                        apiKey: API_KEY, 
                        eventId: market.oddsApiEventId,
                        bookmakers: ALLOWED_BOOKMAKERS
                    },
                    timeout: 8000
                });

                if (response.data) {
                    const eventData = response.data;
                    if (!eventData.id) eventData.id = market.oddsApiEventId;
                    await handleOddsUpdate(eventData);
                }
            } catch (err) {
                console.error(`[Odds Engine] Polling failed for ${market.matchId}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[Odds Engine] Odds Polling cycle failed:', err.message);
    }
}

async function syncEvents() {
    try {
        console.log('[Odds Engine] 🔄 Syncing fixtures from Odds API...');
        const response = await axios.get(`${BASE_URL}/events`, {
            params: { apiKey: API_KEY, sport: 'cricket', status: 'pending,live' }
        });

        if (response.data && Array.isArray(response.data)) {
            for (const event of response.data) {
                await handleOddsUpdate(event);
            }
        }
    } catch (err) {
        console.error('[Odds Engine] Event Sync failed:', err.message);
    }
}

async function checkStaleOdds() {
    const staleTime = new Date(Date.now() - STALE_TIMEOUT_MS);
    const staleMarkets = await MarketOdds.find({ 
        updatedAt: { $lt: staleTime },
        marketStatus: 'OPEN'
    });

    for (const market of staleMarkets) {
        const match = await Match.findOne({ matchId: market.matchId });
        if (match && match.status === 'live') {
            await updateMarketStatus(market.matchId, 'SUSPENDED');
        }
    }
}

// ─── Initialization ───────────────────────────────────────────────────────────

function initOddsEngine(io) {
    ioInstance = io;
    syncEvents();
    setInterval(pollAllActiveOdds, 5000); 
    setInterval(syncEvents, 120000); 
    setInterval(checkStaleOdds, 20000);
}

module.exports = { initOddsEngine };
