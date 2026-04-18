const cron = require('node-cron');
const { updateMatchStatuses } = require('../services/statusService');

const initStatusJob = (io) => {
    // Run every 1 minute to check if matches should be live or completed
    cron.schedule('*/1 * * * *', () => {
        updateMatchStatuses(io);
    });
};

module.exports = { initStatusJob };
