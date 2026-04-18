const cron = require('node-cron');
const { fetchUpcomingMatches } = require('../services/matchService');

// Run every 24 hours to fetch new matches
cron.schedule('0 0 * * *', () => {
    console.log('Running daily match fetch job...');
    fetchUpcomingMatches();
});

// Note: Initial fetch is now handled in server.js after DB connection
