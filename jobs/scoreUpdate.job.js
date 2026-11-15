const cron = require('node-cron');
const { updateLiveScores } = require('../services/scoreService');

/**
 * Score Update Job — OddsPapi Fallback
 *
 * Runs every 2 seconds for matches not covered by Sportmonks (e.g. WBBL).
 *
 * Note: OddsPapi source data itself updates every ~15 minutes for some leagues
 * (Women's BBL, minor domestic). Faster polling minimizes the gap between when
 * OddsPapi publishes a new score and when our users see it. The in-memory cache
 * in apiManager.js is now set to 1s to avoid re-serving stale cached responses.
 *
 * The Sportmonks primary engine runs at 1.5s independently (liveScoreJob.js).
 */
const initScoreJob = (io) => {
    // Every 10 seconds — lightweight fallback for matches not covered by Sportmonks
    cron.schedule('*/10 * * * * *', () => {
        updateLiveScores(io);
    });
};

module.exports = { initScoreJob };
