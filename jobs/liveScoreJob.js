const cron = require('node-cron');
const { updateLiveScores } = require('../services/scoreService');

/**
 * Live Score Update Job
 * 
 * Runs every 20 seconds.
 * Orchestrates live score updates via ScoreService.
 */
const initLiveScoreJob = (io) => {
    // Cron schedule: every 15 seconds
    cron.schedule('*/15 * * * * *', async () => {
        try {
            await updateLiveScores(io);
        } catch (error) {
            console.error('[LiveScoreJob] Error:', error.message);
        }
    });

    console.log('✅ LiveScoreJob initialized (15s interval)');
};

module.exports = { initLiveScoreJob };
