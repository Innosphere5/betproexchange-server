const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://v5.oddspapi.io/en';

async function inspectOdds() {
  try {
    console.log("Fetching live or upcoming fixtures to find ones with odds...");
    const fixturesRes = await axios.get(`${BASE_URL}/fixtures`, {
      params: { apiKey: API_KEY, sportId: 27 },
      timeout: 10000
    });
    
    // Filter fixtures that are scheduled or live
    const activeFixtures = fixturesRes.data.filter(f => f.status?.statusName === 'Scheduled' || f.status?.live);
    console.log(`Found ${activeFixtures.length} active fixtures`);

    let foundOdds = false;
    for (const fixture of activeFixtures.slice(0, 15)) {
      const fid = fixture.id || fixture.fixtureId;
      console.log(`Checking odds for: ${fixture.participants?.participant1Name} v ${fixture.participants?.participant2Name} (ID: ${fid})`);
      
      const oddsRes = await axios.get(`${BASE_URL}/fixtures/odds`, {
        params: { apiKey: API_KEY, fixtureId: fid },
        timeout: 10000
      });

      const data = oddsRes.data;
      const odds = data.odds || data.bookmakers || {};
      const bookmakerNames = Object.keys(odds);
      
      if (bookmakerNames.length > 0) {
        console.log(`  -> Available bookmakers: ${bookmakerNames.join(', ')}`);
        
        // Print Pinnacle odds if available
        const pinnacleKey = bookmakerNames.find(name => name.toLowerCase().includes('pinnacle'));
        if (pinnacleKey) {
          console.log(`  -> Pinnacle odds structure:`, JSON.stringify(odds[pinnacleKey], null, 2));
        } else {
          // Print Betfair Exchange or any first available bookmaker odds structure
          const firstBm = bookmakerNames[0];
          console.log(`  -> [${firstBm}] odds structure:`, JSON.stringify(odds[firstBm], null, 2).substring(0, 500));
        }
        foundOdds = true;
      } else {
        console.log(`  -> No bookmakers found.`);
      }
    }
  } catch (err) {
    console.error('Error:', err.response ? err.response.data : err.message);
  }
}

inspectOdds();
