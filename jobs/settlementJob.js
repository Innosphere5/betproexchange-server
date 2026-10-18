const cron = require('node-cron');
const { processMatchResults } = require('../services/resultSettlementService');

/**
 * initSettlementJob
 * 
 * Runs every 5 minutes to check for completed matches and settle bets.
 */
const initSettlementJob = (io) => {
    // Immediate check 3 seconds after startup to settle any pending matches
    setTimeout(() => {
        console.log('[SettlementJob] Initial startup match result check...');
        processMatchResults(io);
    }, 3000);

    // Schedule for every 2 minutes
    cron.schedule('*/2 * * * *', () => {
        console.log('[SettlementJob] Triggering result check...');
        processMatchResults(io);
    });
};

module.exports = { initSettlementJob };
