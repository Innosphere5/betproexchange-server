const cron = require('node-cron');
const { updateLiveScores } = require('../services/scoreService');

// Run every 5 seconds for live matches
cron.schedule('*/5 * * * * *', () => {
    updateLiveScores();
});
