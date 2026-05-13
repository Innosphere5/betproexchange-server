const mongoose = require('mongoose');
require('dotenv').config();
const Match = require('../models/Match');

async function checkOdds() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const matches = await Match.find();
        console.log(`Checking odds for ${matches.length} matches:`);
        matches.forEach(m => {
            console.log(`Teams: ${m.teamA} v ${m.teamB} | OddsA: ${m.backOddsA}/${m.layOddsA} | OddsB: ${m.backOddsB}/${m.layOddsB}`);
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkOdds();
