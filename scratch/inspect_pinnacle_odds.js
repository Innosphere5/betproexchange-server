const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://v5.oddspapi.io/en';

async function inspectPinnacleOdds() {
  try {
    console.log("Fetching active fixtures to find ones with Pinnacle odds...");
    const fixturesRes = await axios.get(`${BASE_URL}/fixtures`, {
      params: { apiKey: API_KEY, sportId: 27 },
      timeout: 10000
    });
    
    const activeFixtures = fixturesRes.data.filter(f => f.status?.statusName === 'Scheduled' || f.status?.live);
    console.log(`Found ${activeFixtures.length} active fixtures`);

    for (const fixture of activeFixtures.slice(0, 10)) {
      const fid = fixture.fixtureId || fixture.id;
      const p1 = fixture.participants?.participant1Name || '?';
      const p2 = fixture.participants?.participant2Name || '?';
      console.log(`\n--- Checking: ${p1} v ${p2} (ID: ${fid}) ---`);
      
      // Request odds with bookmakers=pinnacle
      const oddsRes = await axios.get(`${BASE_URL}/fixtures/odds`, {
        params: { apiKey: API_KEY, fixtureId: fid, bookmakers: 'pinnacle' },
        timeout: 10000
      });

      const data = oddsRes.data;
      const odds = data.odds || {};
      const bookmakerNames = Object.keys(odds);
      
      if (bookmakerNames.length > 0) {
        console.log(`  Bookmakers returned: ${bookmakerNames.join(', ')}`);
        const pinnacleOdds = odds['pinnacle'];
        if (pinnacleOdds) {
          console.log(`  Pinnacle odds structure:`);
          for (const [oddsId, quote] of Object.entries(pinnacleOdds)) {
            console.log(`    oddsId: ${oddsId}`);
            console.log(`    outcomeId: ${quote.outcomeId}, marketId: ${quote.marketId}, price: ${quote.price}, active: ${quote.active}`);
            console.log(`    limit: ${quote.limit}, mainLine: ${quote.mainLine}`);
            console.log(`    meta: ${JSON.stringify(quote.meta)}`);
            console.log(`    ---`);
          }
        } else {
          console.log(`  No 'pinnacle' key found in odds.`);
          // Print what was found instead
          const firstBm = bookmakerNames[0];
          const sample = odds[firstBm];
          const keys = Object.keys(sample).slice(0, 2);
          for (const k of keys) {
            console.log(`  [${firstBm}] ${k}: outcomeId=${sample[k].outcomeId} price=${sample[k].price} marketId=${sample[k].marketId}`);
          }
        }
      } else {
        console.log(`  No bookmakers found.`);
      }

      // Also request with both bookmakers for comparison
      const bothRes = await axios.get(`${BASE_URL}/fixtures/odds`, {
        params: { apiKey: API_KEY, fixtureId: fid, bookmakers: 'betfair-ex,pinnacle' },
        timeout: 10000
      });
      const bothOdds = bothRes.data.odds || {};
      console.log(`  Both bookmakers present: ${Object.keys(bothOdds).join(', ') || 'NONE'}`);
    }
  } catch (err) {
    console.error('Error:', err.response ? err.response.data : err.message);
  }
}

inspectPinnacleOdds();
