const mongoose = require('mongoose');
const Match = require('../models/Match');
require('dotenv').config();

async function checkOdds() {
    await mongoose.connect(process.env.MONGO_URI);
    const matchesWithOdds = await Match.find({ backOddsA: { $ne: null } });
    console.log(`Found ${matchesWithOdds.length} matches with non-null odds.`);
    matchesWithOdds.forEach(m => {
        console.log(`- ${m.teamA} v ${m.teamB} [${m.matchId}]: ${m.backOddsA} / ${m.layOddsA}`);
    });
    process.exit(0);
}

checkOdds();
