const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY?.trim();

async function testKeys() {
  const keys = [
      { name: 'ODDS_API_KEY', value: process.env.ODDS_API_KEY?.trim() },
      { name: 'API_KEY (Sportmonks?)', value: process.env.API_KEY?.trim() }
  ];

  for (const key of keys) {
      console.log(`\n--- Testing ${key.name}: ${key.value} ---`);
      try {
          const r1 = await axios.get('https://api.odds-api.io/v3/events', { params: { apiKey: key.value } });
          console.log(`${key.name} on odds-api.io: SUCCESS! Status:`, r1.status);
      } catch (err) {
          console.log(`${key.name} on odds-api.io: FAILED:`, err.response ? err.response.status : err.message);
      }
  }
}

testKeys();

