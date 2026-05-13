const mongoose = require('mongoose');
require('dotenv').config();
const Match = require('../models/Match');

async function checkMatches() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const matches = await Match.find();
        console.log(`Found ${matches.length} matches in DB:`);
        matches.forEach(m => {
            console.log(`ID: ${m.matchId} | Teams: ${m.teamA} v ${m.teamB} | Status: ${m.status} | Start: ${m.startTime}`);
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkMatches();
