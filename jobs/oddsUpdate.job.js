const { updateOdds } = require('../services/oddsService');

function initOddsJob(io) {
  console.log('🚀 Initializing Odds Update Job (Every 120s - Safe for Free Plan)');
  
  // Initial run
  updateOdds(io);

  // Set interval (120 seconds to stay strictly under 100 requests/hour limit)
  setInterval(() => {
    updateOdds(io);
  }, 120000);
}



module.exports = { initOddsJob };
