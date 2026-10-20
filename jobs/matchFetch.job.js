const cron = require('node-cron');
const { fetchUpcomingMatches } = require('../services/matchService');

/**
 * Match Fetch Cron Job
 *
 * Runs every 24 hours to fetch new matches into the database.
 */
const initMatchFetchJob = (io) => {
    // Runs every 15 minutes to keep upcoming & live fixtures synced with oddspapi
    cron.schedule('*/15 * * * *', () => {
        console.log('[Cron] Running periodic match fetch job (every 15m)...');
        fetchUpcomingMatches(io);
    });
};

module.exports = { initMatchFetchJob };
