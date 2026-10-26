const { sportmonksScoreService } = require('../services/sportmonksScoreService');

/**
 * Live Score Real-Time Engine Job
 * 
 * Sub-3s adaptive polling for live cricket in-play matches using Sportmonks API.
 * Emits real-time live_score_update events via Socket.IO with zero delay.
 */
const initLiveScoreJob = (io) => {
    sportmonksScoreService.startLiveScoreEngine(io);
    console.log('✅ Real-time Sportmonks LiveScore Engine initialized');
};

module.exports = { initLiveScoreJob };

