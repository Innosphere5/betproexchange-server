const cron = require('node-cron');
const { updateLiveScores } = require('../services/scoreService');

/**
 * Score Update Cron Job (OddsPapi Fallback Only)
 *
 * Runs every 30 seconds. Handles ONLY matches that Sportmonks doesn't cover.
 * The primary real-time Sportmonks polling is handled by liveScoreJob.js's
 * adaptive 1.5s engine — this cron must NOT call syncLiveScores() to avoid
 * mutex contention and stale OddsPapi data overwriting fresh Sportmonks scores.
 */
const initScoreJob = (io) => {
    // Run every 30 seconds as a safety net for non-Sportmonks matches
    cron.schedule('*/30 * * * * *', () => {
        updateLiveScores(io);
    });
};

module.exports = { initScoreJob };
