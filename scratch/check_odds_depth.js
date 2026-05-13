const mongoose = require('mongoose');
require('dotenv').config();
const Match = require('../models/Match');

async function checkOdds() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const matches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
        console.log(`Checking odds for ${matches.length} matches:`);
        matches.forEach(m => {
            console.log(`Teams: ${m.teamA} v ${m.teamB}`);
            console.log(`  Odds: ${m.backOddsA}/${m.layOddsA} | ${m.backOddsB}/${m.layOddsB}`);
            console.log(`  Depth: ${m.depthBackA}/${m.depthLayA} | ${m.depthBackB}/${m.depthLayB}`);
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkOdds();
