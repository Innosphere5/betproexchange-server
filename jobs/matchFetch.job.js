const cron = require('node-cron');
const { fetchUpcomingMatches } = require('../services/matchService');

/**
 * Match Fetch Cron Job
 *
 * Runs every 24 hours to fetch new matches into the database.
 */
const initMatchFetchJob = (io) => {
    cron.schedule('0 0 * * *', () => {
        console.log('Running daily match fetch job...');
        fetchUpcomingMatches(io);
    });
};

module.exports = { initMatchFetchJob };
