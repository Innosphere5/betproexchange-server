const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://v5.oddspapi.io/en';

async function checkApi() {
  try {
    console.log(`Testing v5.oddspapi.io with key: ${API_KEY}`);
    const res = await axios.get(`${BASE_URL}/sports`, {
      params: { apiKey: API_KEY },
      timeout: 10000
    });
    console.log('Sports Response status:', res.status);
    console.log('Sports found:', res.data);
    
    console.log('\nFetching today fixtures...');
    const fixturesRes = await axios.get(`${BASE_URL}/fixtures`, {
      params: { apiKey: API_KEY, sportId: 27 },
      timeout: 10000
    });
    console.log(`Fixtures found: ${fixturesRes.data.length}`);
    if (fixturesRes.data.length > 0) {
      console.log('Sample fixture:', JSON.stringify(fixturesRes.data[0], null, 2));
      const firstFixtureId = fixturesRes.data[0].id || fixturesRes.data[0].fixtureId;
      console.log(`\nFetching odds for fixture ${firstFixtureId}...`);
      const oddsRes = await axios.get(`${BASE_URL}/fixtures/odds`, {
        params: { apiKey: API_KEY, fixtureId: firstFixtureId },
        timeout: 10000
      });
      console.log('Odds response keys:', Object.keys(oddsRes.data));
      if (Array.isArray(oddsRes.data)) {
        console.log('Odds array sample:', JSON.stringify(oddsRes.data[0], null, 2));
      } else {
        console.log('Odds object keys/sample:', JSON.stringify(oddsRes.data, null, 2).substring(0, 500));
      }
    }
  } catch (err) {
    console.error('API Error:', err.response ? err.response.data : err.message);
  }
}

checkApi();
