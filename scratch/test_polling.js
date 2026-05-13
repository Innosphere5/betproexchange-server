const mongoose = require('mongoose');
require('dotenv').config();
const Match = require('../models/Match');
const OddsMarket = require('../models/OddsMarket');
const oddsApiService = require('../services/oddsApiService');

async function testPolling() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const market = await OddsMarket.findOne({ teamA: 'Royal Challengers Bengaluru' });
        if (!market) {
            console.log('No market for RCB found in OddsMarket.');
            process.exit(1);
        }
        
        console.log(`Polling for ${market.teamA} (Event: ${market.oddsApiEventId})...`);
        const data = await oddsApiService.fetch('odds', { 
            eventId: market.oddsApiEventId,
            bookmakers: 'SingBet,Betfair Exchange,Bet365,1xbet,Stake'
        });
        
        if (data && data.bookmakers) {
            console.log('Bookmakers in response:', Object.keys(data.bookmakers).join(', '));
            const preferred = ['SingBet', 'Betfair Exchange', 'Bet365', '1xbet', 'Stake'];
            let mlMarket = null;
            for (const bmName of preferred) {
                if (data.bookmakers[bmName]) {
                    mlMarket = data.bookmakers[bmName].find(m => m.name === 'ML' || m.name === 'Match Winner' || m.name === 'h2h');
                    if (mlMarket) {
                        console.log(`Found ML market in ${bmName}`);
                        break;
                    }
                }
            }
            
            if (mlMarket && mlMarket.odds && mlMarket.odds[0]) {
                const oddsData = mlMarket.odds[0];
                console.log('Odds Data:', oddsData);
                const teamABack = Number(oddsData.home || oddsData.back || oddsData.backHome);
                console.log(`Team A Back: ${teamABack}`);
            } else {
                console.log('ML Market not found or empty odds.');
            }
        } else {
            console.log('No data from API.');
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

testPolling();
