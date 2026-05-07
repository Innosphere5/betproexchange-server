const mongoose = require('mongoose');
const MarketOdds = require('../models/MarketOdds');
const Match = require('../models/Match');
require('dotenv').config();

async function checkMappings() {
    await mongoose.connect(process.env.MONGO_URI);
    const mappings = await MarketOdds.find();
    console.log(`Found ${mappings.length} mappings in MarketOdds:`);
    for (const m of mappings) {
        const match = await Match.findOne({ matchId: m.matchId });
        console.log(`- Match ${m.matchId} (${match ? match.teamA + ' v ' + match.teamB : '???'}) -> API Event ${m.oddsApiEventId} | Status: ${m.marketStatus} | Odds: ${JSON.stringify(m.teamA)} / ${JSON.stringify(m.teamB)}`);
    }
    process.exit(0);
}

checkMappings();
