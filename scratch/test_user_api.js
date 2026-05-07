const axios = require('axios');

async function testOddsApiIo() {
  const API_KEY = '3e13b69aec131a5623a0a5a3ca327138f1330814666df778863dad769af2b067';
  const BASE_URL = 'https://api.odds-api.io/v3';

  try {
    console.log('Fetching bookmakers...');
    const bmRes = await axios.get(`${BASE_URL}/bookmakers`, {
      params: { apiKey: API_KEY }
    });
    console.log('Bookmakers:', JSON.stringify(bmRes.data, null, 2));
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
}

testOddsApiIo();
