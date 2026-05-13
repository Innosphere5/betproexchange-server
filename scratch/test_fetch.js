const mongoose = require('mongoose');
require('dotenv').config();
const { fetchUpcomingMatches } = require('../services/matchService');

async function testFetch() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB. Running fetchUpcomingMatches...');
        await fetchUpcomingMatches(null); // No io needed for test
        console.log('Fetch complete.');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

testFetch();
