const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://v5.oddspapi.io/en';

async function listBookmakers() {
  try {
    console.log(`Querying bookmakers with key: ${API_KEY}`);
    const res = await axios.get(`${BASE_URL}/bookmakers`, {
      params: { apiKey: API_KEY },
      timeout: 10000
    });
    console.log('Bookmakers raw response:', JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error('API Error:', err.response ? err.response.data : err.message);
  }
}

listBookmakers();
