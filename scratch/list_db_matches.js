const mongoose = require('mongoose');
const Match = require('../models/Match');
require('dotenv').config();

async function listMatches() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const matches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
    console.log(`Found ${matches.length} active matches in DB:`);
    matches.forEach(m => {
      console.log(`- [${m.matchId}] ${m.teamA} v ${m.teamB} (${m.league})`);
      console.log(`  Odds: BackA: ${m.backOddsA}, LayA: ${m.layOddsA} | BackB: ${m.backOddsB}, LayB: ${m.layOddsB}`);
      console.log(`  Status: ${m.status}`);
    });
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

listMatches();
