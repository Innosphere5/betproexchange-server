/**
 * Diagnostic script: Verify odds team-order alignment fix.
 * 
 * 1. Connects to MongoDB
 * 2. Fetches live/upcoming matches from DB
 * 3. Fetches fixture metadata + odds from OddsPapi REST
 * 4. Runs the normalize + swap-detection logic
 * 5. Prints what odds WOULD be assigned to each team
 */

const mongoose = require('mongoose');
const Match = require('../models/Match');
const oddsPapiRest = require('../services/oddsPapiRest');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const CRICKET_SPORT_ID = 27;
const BOOKMAKERS = ['betfair-ex', 'pinnacle'];

// Same normalize function as oddsPapiService
function normalize(name) {
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

function formatDepth(val) {
    if (!val && val !== 0) return '100';
    const n = Number(val);
    if (isNaN(n)) return String(val);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return Math.floor(n).toString();
}

function parseExchangeOdd(odd) {
    let back = 0, lay = 0, depthBack = '0', depthLay = '0';
    if (odd.meta) {
        const backBook = odd.meta.availableToBack || odd.meta.back || [];
        const layBook = odd.meta.availableToLay || odd.meta.lay || [];
        if (backBook.length > 0) {
            const bestBack = backBook.reduce((best, curr) => curr.price > best.price ? curr : best, backBook[0]);
            back = bestBack.price;
            depthBack = formatDepth(bestBack.size);
        }
        if (layBook.length > 0) {
            const bestLay = layBook.reduce((best, curr) => curr.price < best.price ? curr : best, layBook[0]);
            lay = bestLay.price;
            depthLay = formatDepth(bestLay.size);
        }
    }
    if (back === 0 && odd.price) {
        back = odd.price;
        depthBack = formatDepth(odd.limit);
    }
    if (lay === 0 && back > 0) {
        lay = Number((back + 0.02).toFixed(2));
        depthLay = formatDepth(null);
    }
    return { back, lay, depthBack, depthLay };
}

function parseTraditionalOdd(odd) {
    const back = odd.price || 0;
    const depthBack = formatDepth(odd.limit);
    const lay = back > 0 ? Number((back + 0.01).toFixed(2)) : 0;
    const depthLay = formatDepth(null);
    return { back, lay, depthBack, depthLay };
}

async function run() {
    console.log('=== Odds Swap Diagnostic ===\n');

    // 1. Connect to DB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // 2. Get live/upcoming matches from DB
    const dbMatches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
    console.log(`📋 DB Matches (${dbMatches.length}):`);
    for (const m of dbMatches) {
        console.log(`   ${m.matchId}: ${m.teamA} vs ${m.teamB} [${m.status}] | Current DB Odds: A(${m.backOddsA}/${m.layOddsA}) B(${m.backOddsB}/${m.layOddsB})`);
    }
    console.log('');

    // 3. Fetch fixtures from OddsPapi REST
    console.log('🌐 Fetching fixtures from OddsPapi REST...');
    let fixtures;
    try {
        fixtures = await oddsPapiRest.getFixturesToday({
            sportId: CRICKET_SPORT_ID,
            bookmakers: BOOKMAKERS.join(',')
        });
    } catch (err) {
        console.error('❌ Failed to fetch fixtures:', err.message);
        await mongoose.disconnect();
        return;
    }

    if (!fixtures || !Array.isArray(fixtures)) {
        console.log('⚠️ No fixtures returned');
        await mongoose.disconnect();
        return;
    }

    console.log(`📋 OddsPapi Fixtures (${fixtures.length}):\n`);

    // 4. For each fixture, try to match with DB and check team order
    for (const fixture of fixtures) {
        if (!fixture.fixtureId || !fixture.participants) continue;

        const p1 = fixture.participants.participant1Name || '?';
        const p2 = fixture.participants.participant2Name || '?';
        const p1Id = fixture.participants.participant1Id;
        const p2Id = fixture.participants.participant2Id;

        console.log(`─── Fixture ${fixture.fixtureId}: ${p1} vs ${p2} ───`);
        console.log(`   participant1Id: ${p1Id}, participant2Id: ${p2Id}`);

        const apiP1Norm = normalize(p1);
        const apiP2Norm = normalize(p2);

        // Try to match with DB
        let matchedDb = null;
        for (const dbMatch of dbMatches) {
            const dbHomeNorm = normalize(dbMatch.teamA);
            const dbAwayNorm = normalize(dbMatch.teamB);
            const teamsMatch =
                (dbHomeNorm === apiP1Norm && dbAwayNorm === apiP2Norm) ||
                (dbHomeNorm === apiP2Norm && dbAwayNorm === apiP1Norm);
            if (teamsMatch) {
                matchedDb = dbMatch;
                break;
            }
        }

        if (!matchedDb) {
            console.log(`   ⚠️ No DB match found\n`);
            continue;
        }

        console.log(`   ✅ Matched DB: ${matchedDb.matchId} (${matchedDb.teamA} vs ${matchedDb.teamB})`);

        // Check swap
        const dbTeamA = normalize(matchedDb.teamA);
        const needsSwap = dbTeamA === apiP2Norm && dbTeamA !== apiP1Norm;
        console.log(`   🔄 Needs swap: ${needsSwap ? 'YES ← API order reversed from DB' : 'NO — order matches'}`);

        // 5. Fetch odds for this fixture
        try {
            const oddsData = await oddsPapiRest.getFixtureOdds(fixture.fixtureId, BOOKMAKERS);
            if (!oddsData || !oddsData.odds) {
                console.log(`   ⚠️ No odds data\n`);
                continue;
            }

            // Try betfair-ex first
            const bookmakerKey = oddsData.odds['betfair-ex'] ? 'betfair-ex' : 
                                 oddsData.odds['pinnacle'] ? 'pinnacle' : null;
            
            if (!bookmakerKey) {
                console.log(`   ⚠️ No odds from target bookmakers\n`);
                continue;
            }

            const bkOdds = oddsData.odds[bookmakerKey];
            const isExchange = bookmakerKey === 'betfair-ex';
            const oddsEntries = Object.values(bkOdds);
            const activeOdds = oddsEntries.filter(o => o.active !== false);

            // Group by marketId
            const marketGroups = {};
            for (const odd of activeOdds) {
                const mId = odd.marketId;
                if (!marketGroups[mId]) marketGroups[mId] = [];
                marketGroups[mId].push(odd);
            }

            // Find 2-outcome market
            let winnerMarket = null;
            for (const [mId, outcomes] of Object.entries(marketGroups)) {
                const mainLine = outcomes.filter(o => o.mainLine === true || o.mainLine === null || o.mainLine === undefined);
                if (mainLine.length === 2 && mainLine.every(o => o.playerId === 0)) {
                    winnerMarket = mainLine;
                    break;
                }
            }
            if (!winnerMarket) {
                for (const [mId, outcomes] of Object.entries(marketGroups)) {
                    if (outcomes.length === 2 && outcomes.every(o => o.playerId === 0)) {
                        winnerMarket = outcomes;
                        break;
                    }
                }
            }

            if (!winnerMarket || winnerMarket.length < 2) {
                console.log(`   ⚠️ No winner market found\n`);
                continue;
            }

            // Use participantId mapping (Fix 1)
            let p1Odd = null, p2Odd = null;
            if (p1Id || p2Id) {
                for (const odd of winnerMarket) {
                    if (odd.participantId === p1Id) p1Odd = odd;
                    else if (odd.participantId === p2Id) p2Odd = odd;
                }
            }
            const usedParticipantId = !!(p1Odd && p2Odd);
            if (!p1Odd || !p2Odd) {
                winnerMarket.sort((a, b) => a.outcomeId - b.outcomeId);
                p1Odd = winnerMarket[0];
                p2Odd = winnerMarket[1];
            }

            const parsedP1 = isExchange ? parseExchangeOdd(p1Odd) : parseTraditionalOdd(p1Odd);
            const parsedP2 = isExchange ? parseExchangeOdd(p2Odd) : parseTraditionalOdd(p2Odd);

            console.log(`   📊 Raw API odds (via ${bookmakerKey}, participantId mapping: ${usedParticipantId}):`);
            console.log(`      participant1 (${p1}): Back ${parsedP1.back} / Lay ${parsedP1.lay}`);
            console.log(`      participant2 (${p2}): Back ${parsedP2.back} / Lay ${parsedP2.lay}`);

            // Apply swap (Fix 2)
            const alignedA = needsSwap ? parsedP2 : parsedP1;
            const alignedB = needsSwap ? parsedP1 : parsedP2;

            console.log(`   ✅ FINAL odds after alignment (swap=${needsSwap}):`);
            console.log(`      DB teamA (${matchedDb.teamA}): Back ${alignedA.back} / Lay ${alignedA.lay}`);
            console.log(`      DB teamB (${matchedDb.teamB}): Back ${alignedB.back} / Lay ${alignedB.lay}`);
            console.log(`   📌 Currently in DB:`);
            console.log(`      teamA (${matchedDb.teamA}): Back ${matchedDb.backOddsA} / Lay ${matchedDb.layOddsA}`);
            console.log(`      teamB (${matchedDb.teamB}): Back ${matchedDb.backOddsB} / Lay ${matchedDb.layOddsB}`);
        } catch (err) {
            console.log(`   ❌ Odds fetch error: ${err.message}`);
        }
        console.log('');
    }

    await mongoose.disconnect();
    console.log('Done.');
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
