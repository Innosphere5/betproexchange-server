/**
 * Deep diagnostic: Check Pakistan vs Australia match specifically
 * - Try multiple REST endpoints
 * - Check OddsMarket collection for existing fixture mapping
 */

const mongoose = require('mongoose');
const Match = require('../models/Match');
const MarketOdds = require('../models/MarketOdds');
const OddsMarket = require('../models/OddsMarket');
const oddsPapiRest = require('../services/oddsPapiRest');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const CRICKET_SPORT_ID = 27;
const BOOKMAKERS = ['betfair-ex', 'pinnacle'];

async function run() {
    console.log('=== Pakistan vs Australia Deep Diagnostic ===\n');

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // 1. Check the Match document
    const match = await Match.findOne({ matchId: '69921' });
    if (match) {
        console.log('📋 Match Document (matchId: 69921):');
        console.log(`   teamA: ${match.teamA}`);
        console.log(`   teamB: ${match.teamB}`);
        console.log(`   status: ${match.status}`);
        console.log(`   backOddsA: ${match.backOddsA}, layOddsA: ${match.layOddsA}`);
        console.log(`   backOddsB: ${match.backOddsB}, layOddsB: ${match.layOddsB}`);
        console.log(`   depthBackA: ${match.depthBackA}, depthLayA: ${match.depthLayA}`);
        console.log(`   depthBackB: ${match.depthBackB}, depthLayB: ${match.depthLayB}`);
        console.log(`   marketStatus: ${match.marketStatus}`);
        console.log(`   lastUpdated: ${match.lastUpdated}`);
    } else {
        console.log('❌ Match 69921 not found!');
    }

    // 2. Check MarketOdds collection
    const marketOdds = await MarketOdds.findOne({ matchId: '69921' });
    if (marketOdds) {
        console.log('\n📋 MarketOdds Document:');
        console.log(`   oddsApiEventId: ${marketOdds.oddsApiEventId}`);
        console.log(`   teamA: ${JSON.stringify(marketOdds.teamA)}`);
        console.log(`   teamB: ${JSON.stringify(marketOdds.teamB)}`);
        console.log(`   bookmaker: ${marketOdds.bookmaker}`);
        console.log(`   marketStatus: ${marketOdds.marketStatus}`);
        console.log(`   updatedAt: ${marketOdds.updatedAt}`);
    } else {
        console.log('\n⚠️ No MarketOdds document for 69921');
    }

    // 3. Check OddsMarket collection
    const oddsMarket = await OddsMarket.findOne({ sportmonksMatchId: '69921' });
    if (oddsMarket) {
        console.log('\n📋 OddsMarket Document:');
        console.log(`   oddsApiEventId: ${oddsMarket.oddsApiEventId}`);
        console.log(`   teamA: ${oddsMarket.teamA}, teamB: ${oddsMarket.teamB}`);
        console.log(`   teamABack: ${oddsMarket.teamABack}, teamALay: ${oddsMarket.teamALay}`);
        console.log(`   teamBBack: ${oddsMarket.teamBBack}, teamBLay: ${oddsMarket.teamBLay}`);
        console.log(`   bookmaker: ${oddsMarket.bookmaker}`);
        console.log(`   updatedAt: ${oddsMarket.updatedAt}`);
    } else {
        console.log('\n⚠️ No OddsMarket document for 69921');
    }

    // 4. Try live fixtures endpoint
    console.log('\n🌐 Trying live fixtures endpoint...');
    try {
        const liveFixtures = await oddsPapiRest.getFixturesLive({
            sportId: CRICKET_SPORT_ID,
            bookmakers: BOOKMAKERS.join(',')
        });
        if (liveFixtures && Array.isArray(liveFixtures)) {
            console.log(`   Got ${liveFixtures.length} live fixtures:`);
            for (const f of liveFixtures) {
                const p1 = f.participants?.participant1Name || '?';
                const p2 = f.participants?.participant2Name || '?';
                console.log(`   - ${f.fixtureId}: ${p1} vs ${p2} (p1Id: ${f.participants?.participant1Id}, p2Id: ${f.participants?.participant2Id})`);
            }
        } else {
            console.log('   No live fixtures returned');
        }
    } catch (err) {
        console.log(`   ❌ Live fixtures error: ${err.message}`);
    }

    // 5. If we have the fixtureId from MarketOdds or OddsMarket, try fetching its odds
    const fixtureId = marketOdds?.oddsApiEventId || oddsMarket?.oddsApiEventId;
    if (fixtureId) {
        console.log(`\n🌐 Fetching odds for fixture ${fixtureId}...`);
        try {
            const oddsData = await oddsPapiRest.getFixtureOdds(fixtureId, BOOKMAKERS);
            if (oddsData && oddsData.odds) {
                const bookmakerKeys = Object.keys(oddsData.odds);
                console.log(`   Bookmakers with odds: ${bookmakerKeys.join(', ')}`);
                
                for (const bk of bookmakerKeys) {
                    const bkOdds = oddsData.odds[bk];
                    const entries = Object.values(bkOdds);
                    console.log(`\n   --- ${bk} (${entries.length} entries) ---`);
                    for (const o of entries.slice(0, 10)) {
                        console.log(`   outcomeId: ${o.outcomeId}, participantId: ${o.participantId}, marketId: ${o.marketId}, price: ${o.price}, active: ${o.active}, playerId: ${o.playerId}`);
                        if (o.meta) {
                            const backBook = o.meta.availableToBack || o.meta.back || [];
                            const layBook = o.meta.availableToLay || o.meta.lay || [];
                            if (backBook.length > 0) console.log(`     back: ${JSON.stringify(backBook)}`);
                            if (layBook.length > 0) console.log(`     lay: ${JSON.stringify(layBook)}`);
                        }
                    }
                }
            } else {
                console.log('   No odds data returned');
            }
        } catch (err) {
            console.log(`   ❌ Odds fetch error: ${err.message}`);
        }
    }

    await mongoose.disconnect();
    console.log('\nDone.');
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
