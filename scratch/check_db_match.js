const mongoose = require('mongoose');
require('dotenv').config();

const Match = require('../models/Match');
const MarketOdds = require('../models/MarketOdds');

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    const m = await Match.findOne({ matchId: '67064' });
    console.log('Match in DB:', JSON.stringify(m, null, 2));

    const mo = await MarketOdds.findOne({ matchId: '67064' });
    console.log('MarketOdds in DB:', JSON.stringify(mo, null, 2));
    await mongoose.disconnect();
}

run();
