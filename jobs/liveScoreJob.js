const { roanuzScoreService } = require('../services/roanuzScoreService');

/**
 * Live Score Real-Time Engine Job
 * 
 * Sub-2s adaptive polling for live cricket in-play matches using Roanuz Cricket API v5.
 * Emits real-time live_score_update events via Socket.IO with zero delay.
 */
const initLiveScoreJob = (io) => {
    roanuzScoreService.startLiveScoreEngine(io);
    console.log('✅ Real-time Roanuz LiveScore Engine initialized');
};

module.exports = { initLiveScoreJob };
