const mongoose = require('mongoose');
require('dotenv').config();
const OddsMarket = require('../models/OddsMarket');

async function checkOddsMarket() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const markets = await OddsMarket.find();
        console.log(`Found ${markets.length} entries in OddsMarket:`);
        markets.forEach(m => {
            console.log(`MatchID: ${m.sportmonksMatchId} | OddsApiID: ${m.oddsApiEventId} | TeamA: ${m.teamA} | BackA: ${m.teamABack} | Updated: ${m.updatedAt}`);
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkOddsMarket();
