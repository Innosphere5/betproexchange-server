const mongoose = require('mongoose');
require('dotenv').config();
const Match = require('../models/Match');
const OddsMarket = require('../models/OddsMarket');
const oddsApiService = require('../services/oddsApiService');

function formatDepth(val) {
    if (!val) return "100";
    const n = Number(val);
    if (isNaN(n)) return val;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return Math.floor(n).toString();
}

function processRunnerOdds(back, lay, depthBack, depthLay, isLive) {
    const b = Number(back);
    const db = formatDepth(depthBack);
    let l, dl;
    if (lay) {
        l = Number(lay);
        dl = formatDepth(depthLay);
    } else {
        const spread = isLive ? 0.03 : 0.01;
        l = Number((b + spread).toFixed(2));
        dl = "100";
    }
    return { back: b, lay: l, depthBack: db, depthLay: dl };
}

async function runManualPoll() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const markets = await OddsMarket.find();
        console.log(`Found ${markets.length} linked markets.`);

        for (const market of markets) {
            console.log(`Polling for ${market.teamA} v ${market.teamB}...`);
            const data = await oddsApiService.fetch('odds', { 
                eventId: market.oddsApiEventId,
                bookmakers: 'SingBet,Betfair Exchange,Bet365,1xbet,Stake'
            });

            if (data && data.bookmakers) {
                const preferred = ['Betfair Exchange', 'SingBet', 'Bet365', '1xbet', 'Stake'];
                let bestA = 0; let bestB = 0; let layA = 0; let layB = 0;
                let depthA = 0; let depthB = 0; let depthLayA = 0; let depthLayB = 0;

                for (const bmName of preferred) {
                    if (data.bookmakers[bmName]) {
                        const found = data.bookmakers[bmName].find(m => m.name === 'ML' || m.name === 'Match Winner' || m.name === 'h2h' || m.name === 'Winner');
                        if (found && found.odds && found.odds[0]) {
                            const odds = found.odds[0];
                            const backA = Number(odds.home || odds.back || 0);
                            const backB = Number(odds.away || odds.backAway || 0);
                            if (backA > bestA) {
                                bestA = backA; layA = Number(odds.layHome || odds.lay || 0);
                                depthA = odds.depthHome || odds.depthBack || 0;
                                depthLayA = odds.depthLayHome || odds.depthLay || 0;
                            }
                            if (backB > bestB) {
                                bestB = backB; layB = Number(odds.layAway || odds.lay || 0);
                                depthB = odds.depthAway || odds.depthBackAway || 0;
                                depthLayB = odds.depthLayAway || odds.depthLayAway || 0;
                            }
                        }
                    }
                }

                if (bestA > 0) {
                    const teamA_odds = processRunnerOdds(bestA, layA, depthA, depthLayA, false);
                    const teamB_odds = processRunnerOdds(bestB, layB, depthB, depthLayB, false);

                    await Match.findOneAndUpdate(
                        { matchId: market.sportmonksMatchId },
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
                    console.log(`✅ Updated ${market.teamA} v ${market.teamB}`);
                } else {
                    console.log(`❌ No ML market for ${market.teamA}`);
                }
            }
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

runManualPoll();
