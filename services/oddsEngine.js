const Match = require('../models/Match');
const MarketOdds = require('../models/MarketOdds');
const oddsApiService = require('./oddsApiService');
require('dotenv').config();

// ALLOWED BOOKMAKERS FOR THIS STARTER PLAN KEY
const ALLOWED_BOOKMAKERS = 'Betfair Exchange,SingBet,Bet365,1xbet,Stake';

let ioInstance = null;
const STALE_TIMEOUT_MS = 60000;
const pendingFetches = new Set();

// ─── Normalization & Mapping ───────────────────────────────────────────────────

const normalize = (name) => {
    if (!name) return "";
    let n = name.toLowerCase().trim();
    
    // Remove common suffixes and descriptors that cause mismatches
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
        "royalchallengers": "rcb",
        "bengaluru": "rcb",
        "bangalore": "rcb",
        "lucknow": "lsg",
        "sunrisers": "srh",
        "hyderabad": "srh",
        "mumbaiindians": "mi",
        "mumbai": "mi",
        "chennaisuperkings": "csk",
        "chennai": "csk",
        "delhicapitals": "dc",
        "delhi": "dc",
        "rajasthanroyals": "rr",
        "rajasthan": "rr",
        "gujarattitans": "gt",
        "gujarat": "gt",
        "kolkataknightriders": "kkr",
        "kolkata": "kkr",
        "punjabkings": "pbks",
        "kingsxi": "pbks",
        "punjab": "pbks"
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
    // Keep spreads extremely tight to match competitive exchange rates
    return isLive ? 0.01 : 0.01;
}

const formatDepth = (val) => {
    if (!val) return "100";
    const n = Number(val);
    if (isNaN(n)) return val;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return Math.floor(n).toString();
};

function processRunnerOdds(back, lay, depthBack, depthLay, isLive) {
    const b = Number(back);
    const db = formatDepth(depthBack);
    let l, dl;
    
    if (lay && Number(lay) > 0) {
        l = Number(lay);
        dl = formatDepth(depthLay);
    } else {
        const spread = getSpread(isLive);
        l = Number((b + spread).toFixed(2));
        dl = (Math.random() * 500 + 100).toFixed(0); // Synthetic depth
    }
    
    return { back: b, lay: l, depthBack: db, depthLay: dl };
}

// ─── Core Engine ───────────────────────────────────────────────────────────────

async function handleOddsUpdate(eventData, providedMatchId = null) {
    try {
        const { id, home, away, date, status, bookmakers } = eventData;
        const isLive = status === 'live';

        let dbMatches = [];
        if (providedMatchId) {
            const match = await Match.findOne({ matchId: providedMatchId });
            if (match) dbMatches = [match];
        } else {
            dbMatches = await findMatchesForEvent(eventData);
        }
        
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
            let bestA = 0;
            let bestB = 0;
            let layA = 0;
            let layB = 0;
            let depthBackA = 0;
            let depthBackB = 0;
            let depthLayA = 0;
            let depthLayB = 0;
            let selectedBM = 'Multiple';

            for (const bmName of preferred) {
                if (bookmakers[bmName]) {
                    const found = bookmakers[bmName].find(m => m.name === 'ML' || m.name === 'Match Winner' || m.name === 'h2h' || m.name === 'Winner');
                    if (found && found.odds && found.odds[0]) {
                        const odds = found.odds[0];
                        const backA = Number(odds.home || odds.back || 0);
                        const backB = Number(odds.away || odds.backAway || 0);
                        
                        if (backA > bestA) {
                            bestA = backA;
                            layA = Number(odds.layHome || odds.lay || 0);
                            depthBackA = odds.depthHome || odds.depthBack || 0;
                            depthLayA = odds.depthLayHome || odds.depthLay || 0;
                            selectedBM = bmName;
                        }
                        if (backB > bestB) {
                            bestB = backB;
                            layB = Number(odds.layAway || odds.lay || 0);
                            depthBackB = odds.depthAway || odds.depthBackAway || 0;
                            depthLayB = odds.depthLayAway || odds.depthLay || 0;
                        }
                    }
                }
            }
            
            if (bestA === 0) {
                console.log(`[Odds Engine] ⚠️ No ML market found for ${dbMatch.teamA} v ${dbMatch.teamB}`);
                continue;
            }

            const teamA_odds = processRunnerOdds(bestA, layA, depthBackA, depthLayA, isLive);
            const teamB_odds = processRunnerOdds(bestB, layB, depthBackB, depthLayB, isLive);

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
                    depthBackA: teamA_odds.depthBack,
                    depthLayA: teamA_odds.depthLay,
                    depthBackB: teamB_odds.depthBack,
                    depthLayB: teamB_odds.depthLay,
                    marketStatus: 'OPEN',
                    lastUpdated: new Date()
                }
            );

            console.log(`[Odds Engine] ✅ Odds updated for ${dbMatch.teamA} v ${dbMatch.teamB} via ${selectedBM}`);

            if (ioInstance) {
                ioInstance.emit('market_odds_update', {
                    matchId: dbMatch.matchId,
                    runners: [
                        { 
                            name: dbMatch.teamA, 
                            back: teamA_odds.back, 
                            lay: teamA_odds.lay,
                            depthBack: teamA_odds.depthBack,
                            depthLay: teamA_odds.depthLay
                        },
                        { 
                            name: dbMatch.teamB, 
                            back: teamB_odds.back, 
                            lay: teamB_odds.lay,
                            depthBack: teamB_odds.depthBack,
                            depthLay: teamB_odds.depthLay
                        }
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

            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
            const matchStartTime = new Date(match.startTime);

            const isLive = match.status === 'live';
            const isToday = matchStartTime >= todayStart && matchStartTime < todayEnd;

            // Only poll if the match is LIVE or starts TODAY
            if (!isLive && !isToday) continue;

            const lastUpdate = new Date(market.updatedAt).getTime();
            const waitTime = isLive ? 1000 : 5000; 

            if (now.getTime() - lastUpdate < waitTime) continue;
            if (pendingFetches.has(market.matchId)) continue;

            console.log(`[Odds Engine] 🔄 Queuing ${match.status} odds poll for ${match.teamA} v ${match.teamB}...`);
            
            pendingFetches.add(market.matchId);
            oddsApiService.fetch('odds', { 
                eventId: market.oddsApiEventId,
                bookmakers: ALLOWED_BOOKMAKERS
            }, isLive ? 10 : 1)
            .then(async (data) => {
                if (data) {
                    const eventData = data;
                    // For polling, we already know the matchId
                    await handleOddsUpdate(eventData, market.matchId);
                }
            })
            .catch(err => {
                console.error(`[Odds Engine] Polling failed for ${market.matchId}: ${err.message}`);
            })
            .finally(() => {
                pendingFetches.delete(market.matchId);
            });
        }
    } catch (err) {
        console.error('[Odds Engine] Odds Polling cycle failed:', err.message);
    }
}

async function syncEvents() {
    try {
        console.log('[Odds Engine] 🔄 Syncing fixtures from Odds API...');
        const data = await oddsApiService.fetch('events', { 
            sport: 'cricket', 
            status: 'pending,live' 
        }, 5); // Priority 5 for global sync

        if (data && Array.isArray(data)) {
            for (const event of data) {
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
    setInterval(pollAllActiveOdds, 1000); 
    setInterval(syncEvents, 120000); 
    setInterval(checkStaleOdds, 20000);
}

module.exports = { initOddsEngine };
