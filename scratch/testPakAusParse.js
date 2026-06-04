/**
 * Verify: Can we get Pakistan vs Australia fixture from different endpoints?
 * And test the actual odds parsing with the swap fix.
 */

const mongoose = require('mongoose');
const Match = require('../models/Match');
const oddsPapiRest = require('../services/oddsPapiRest');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const CRICKET_SPORT_ID = 27;
const BOOKMAKERS = ['betfair-ex', 'pinnacle'];
const PAK_AUS_FIXTURE_ID = 'id2702833171486560';

function formatDepth(val) {
    if (!val && val !== 0) return '100';
    const n = Number(val);
    if (isNaN(n)) return String(val);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return Math.floor(n).toString();
}

async function run() {
    console.log('=== Pakistan vs Australia — Odds Parsing Test ===\n');

    await mongoose.connect(process.env.MONGO_URI);

    // 1. Fetch odds for the known fixture
    console.log(`🌐 Fetching odds for fixture ${PAK_AUS_FIXTURE_ID}...`);
    const oddsData = await oddsPapiRest.getFixtureOdds(PAK_AUS_FIXTURE_ID, BOOKMAKERS);

    if (!oddsData || !oddsData.odds || !oddsData.odds['betfair-ex']) {
        console.log('❌ No betfair-ex odds available');
        await mongoose.disconnect();
        return;
    }

    const bkOdds = oddsData.odds['betfair-ex'];
    const entries = Object.values(bkOdds);
    const activeOdds = entries.filter(o => o.active !== false);

    // Group by marketId
    const marketGroups = {};
    for (const odd of activeOdds) {
        const mId = odd.marketId;
        if (!marketGroups[mId]) marketGroups[mId] = [];
        marketGroups[mId].push(odd);
    }

    console.log('\n📊 Market Groups:');
    for (const [mId, outcomes] of Object.entries(marketGroups)) {
        const mainLine = outcomes.filter(o => o.mainLine === true || o.mainLine === null || o.mainLine === undefined);
        const allNonPlayer = outcomes.every(o => o.playerId === 0);
        console.log(`   marketId ${mId}: ${outcomes.length} outcomes (mainLine filter: ${mainLine.length}, allNonPlayer: ${allNonPlayer})`);
        for (const o of outcomes) {
            const backBook = o.meta?.availableToBack || o.meta?.back || [];
            const layBook = o.meta?.availableToLay || o.meta?.lay || [];
            const bestBack = backBook.length > 0 ? backBook.reduce((b, c) => c.price > b.price ? c : b, backBook[0]) : null;
            const bestLay = layBook.length > 0 ? layBook.reduce((b, c) => c.price < b.price ? c : b, layBook[0]) : null;
            console.log(`     outcomeId ${o.outcomeId}: price=${o.price}, participantId=${o.participantId}, mainLine=${o.mainLine}, bestBack=${bestBack?.price || 'N/A'}(${formatDepth(bestBack?.size)}), bestLay=${bestLay?.price || 'N/A'}(${formatDepth(bestLay?.size)})`);
        }
    }

    // Find the winner market (exactly 2 outcomes, all non-player)
    let winnerMarket = null;
    let winnerMarketId = null;
    for (const [mId, outcomes] of Object.entries(marketGroups)) {
        const mainLine = outcomes.filter(o => o.mainLine === true || o.mainLine === null || o.mainLine === undefined);
        if (mainLine.length === 2 && mainLine.every(o => o.playerId === 0)) {
            winnerMarket = mainLine;
            winnerMarketId = mId;
            break;
        }
    }
    if (!winnerMarket) {
        for (const [mId, outcomes] of Object.entries(marketGroups)) {
            if (outcomes.length === 2 && outcomes.every(o => o.playerId === 0)) {
                winnerMarket = outcomes;
                winnerMarketId = mId;
                break;
            }
        }
    }

    if (!winnerMarket) {
        console.log('\n❌ No winner market found!');
        await mongoose.disconnect();
        return;
    }

    console.log(`\n✅ Selected winner market: marketId ${winnerMarketId} (${winnerMarket.length} outcomes)`);

    // Sort by outcomeId (since participantId is undefined)
    winnerMarket.sort((a, b) => a.outcomeId - b.outcomeId);

    for (const o of winnerMarket) {
        const backBook = o.meta?.availableToBack || o.meta?.back || [];
        const layBook = o.meta?.availableToLay || o.meta?.lay || [];
        const bestBack = backBook.length > 0 ? backBook.reduce((b, c) => c.price > b.price ? c : b, backBook[0]) : null;
        const bestLay = layBook.length > 0 ? layBook.reduce((b, c) => c.price < b.price ? c : b, layBook[0]) : null;
        console.log(`   outcomeId ${o.outcomeId}: bestBack=${bestBack?.price}(${formatDepth(bestBack?.size)}) bestLay=${bestLay?.price}(${formatDepth(bestLay?.size)})`);
    }

    // 2. Now check: The fixture metadata — try fetching the fixture info
    console.log('\n🌐 Fetching fixture metadata...');
    try {
        const fixtures = await oddsPapiRest.getFixtures({
            fixtureId: PAK_AUS_FIXTURE_ID,
            sportId: CRICKET_SPORT_ID
        });
        if (fixtures && Array.isArray(fixtures)) {
            for (const f of fixtures) {
                console.log(`   ${f.fixtureId}: ${f.participants?.participant1Name} vs ${f.participants?.participant2Name}`);
                console.log(`   participant1Id: ${f.participants?.participant1Id}, participant2Id: ${f.participants?.participant2Id}`);
                console.log(`   status: ${JSON.stringify(f.status)}`);
            }
        } else if (fixtures && fixtures.fixtureId) {
            console.log(`   ${fixtures.fixtureId}: ${fixtures.participants?.participant1Name} vs ${fixtures.participants?.participant2Name}`);
            console.log(`   participant1Id: ${fixtures.participants?.participant1Id}, participant2Id: ${fixtures.participants?.participant2Id}`);
        } else {
            console.log(`   Response: ${JSON.stringify(fixtures).substring(0, 500)}`);
        }
    } catch (err) {
        console.log(`   ❌ ${err.message}`);
    }

    // 3. Get the DB match to check team order
    const match = await Match.findOne({ matchId: '69921' });
    if (match) {
        console.log(`\n📋 DB Match: teamA=${match.teamA}, teamB=${match.teamB}`);
        console.log(`   Conclusion: outcomeId ${winnerMarket[0].outcomeId} (lower) will be parsed as participant1/teamA`);
        
        const p1Back = winnerMarket[0].meta?.availableToBack?.[0]?.price || winnerMarket[0].price;
        const p2Back = winnerMarket[1].meta?.availableToBack?.[0]?.price || winnerMarket[1].price;
        
        console.log(`\n   If API participant1 = Pakistan (odds ~${p1Back}):`);
        console.log(`     → No swap needed, Pakistan(${p1Back}) → teamA, Australia(${p2Back}) → teamB ✅`);
        console.log(`   If API participant1 = Australia (odds ~${p1Back}):`);
        console.log(`     → Swap needed! After swap: Pakistan(${p2Back}) → teamA, Australia(${p1Back}) → teamB`);
        console.log(`\n   💡 Competitor shows: Pakistan=1.06/1.07, Australia=17/17.5`);
        console.log(`   💡 Best back prices from API: ${p1Back} and ${p2Back}`);
        
        if (Math.abs(p1Back - 1.08) < 0.1) {
            console.log(`   ✅ outcomeId ${winnerMarket[0].outcomeId} (price ~1.08) = Pakistan → mapping is CORRECT for teamA`);
        } else if (Math.abs(p2Back - 1.08) < 0.1) {
            console.log(`   🔄 outcomeId ${winnerMarket[1].outcomeId} (price ~1.08) = Pakistan → mapping needs SWAP`);
        }
    }

    await mongoose.disconnect();
    console.log('\nDone.');
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
