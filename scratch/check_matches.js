const mongoose = require('mongoose');
require('dotenv').config();
const Match = require('../models/Match');

async function test() {
  await mongoose.connect(process.env.MONGO_URI);
  const matches = await Match.find().lean();
  console.log('Total matches in DB:', matches.length);
  const interesting = matches.filter(m => 
    m.status !== 'upcoming' || 
    /pakistan|england|australia|new zealand/i.test(m.teamA + ' ' + m.teamB)
  );
  console.log('Interesting matches count:', interesting.length);
  interesting.forEach(m => {
    console.log({
      matchId: m.matchId,
      teamA: m.teamA,
      teamB: m.teamB,
      league: m.league,
      status: m.status,
      winner: m.winner,
      score: m.score,
      startTime: m.startTime
    });
  });
  process.exit(0);
}
test();
