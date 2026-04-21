const cron = require('node-cron');
const { processMatchResults } = require('../services/resultSettlementService');

/**
 * initSettlementJob
 * 
 * Runs every 5 minutes to check for completed matches and settle bets.
 */
const initSettlementJob = (io) => {
    // Schedule for every 1 minute
    cron.schedule('*/1 * * * *', () => {
        console.log('[SettlementJob] Triggering result check...');
        processMatchResults(io);
    });
};

module.exports = { initSettlementJob };
