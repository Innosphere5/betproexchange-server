const mongoose = require('mongoose');
require('dotenv').config();
const MarketOdds = require('../models/MarketOdds');
const oddsApiService = require('../services/oddsApiService');

async function test() {
    await mongoose.connect(process.env.MONGO_URI);
    const market = await MarketOdds.findOne({ matchId: 69657 });
    if (!market) {
        console.log("Market not found");
        process.exit(1);
    }
    
    console.log("Found Market:", market.oddsApiEventId);
    
    const ALLOWED_BOOKMAKERS = 'Betfair Exchange,Bet365,12bet,Orbit Exchange,SkyExchange';
    
    try {
        const data = await oddsApiService.fetch('odds', { 
            eventId: market.oddsApiEventId,
            bookmakers: ALLOWED_BOOKMAKERS
        }, 1);
        if (data && data.bookmakers) {
            console.log("Bookmakers found:");
            for (const [bm, markets] of Object.entries(data.bookmakers)) {
                const ml = markets.find(m => m.name === 'ML');
                if (ml && ml.odds && ml.odds.length > 0) {
                    console.log(`- ${bm}: Home(Back/Lay)=${ml.odds[0].home}/${ml.odds[0].layHome}, Away(Back/Lay)=${ml.odds[0].away}/${ml.odds[0].layAway}`);
                }
            }
        }
    } catch(err) {
        console.error('Error status:', err.response?.status);
        console.error('Error data:', err.response?.data);
    }
    process.exit(0);
}
test();
