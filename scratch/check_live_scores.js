const mongoose = require('mongoose');
const Match = require('../models/Match');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('Connected to DB');
    const liveMatches = await Match.find({ status: 'live' });
    console.log('Live Matches:', liveMatches.length);
    liveMatches.forEach(m => {
        console.log(`Match: ${m.teamA} v ${m.teamB} (${m.matchId})`);
        console.log('Score:', JSON.stringify(m.score, null, 2));
    });
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
