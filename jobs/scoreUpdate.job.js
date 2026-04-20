const cron = require('node-cron');
const { updateLiveScores } = require('../services/scoreService');

/**
 * Score Update Cron Job
 *
 * Runs every 30 seconds. The API Manager caches responses for 30s,
 * so there is AT MOST 1 real HTTP request per 30 seconds — not 12/minute.
 */
const initScoreJob = (io) => {
    // Run every 20 seconds to provide real-time updates as requested
    cron.schedule('*/20 * * * * *', () => {
        updateLiveScores(io);
    });
};

module.exports = { initScoreJob };
