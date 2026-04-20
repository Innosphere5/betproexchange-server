const axios = require('axios');
require('dotenv').config();

async function test() {
  const API_KEY = process.env.API_KEY || '418d9e600687ebb5c3510d95d6d4f369';
  const BASE_URL = 'https://api.the-odds-api.com/v4';
  
  try {
    console.log(`[Test] Using API Key: ${API_KEY.substring(0, 5)}...`);
    // Testing specific sport for scores
    const sport = 'cricket_ipl'; 
    const res = await axios.get(`${BASE_URL}/sports/${sport}/scores`, {
      params: { apiKey: API_KEY, daysFrom: 3 }
    });
    
    console.log(`[Test] Success! Found ${res.data.length} matches with scores.`);
    if (res.data.length > 0) {
      const match = res.data[0];
      console.log(`[Test] Sample Match: ${match.home_team} vs ${match.away_team}`);
      console.log(`[Test] Score Structure:`, JSON.stringify(match.scores, null, 2));
    }
  } catch (e) {
    console.error(`[Test] Error: ${e.response?.status} - ${e.response?.data?.message || e.message}`);
  }
}

test();
