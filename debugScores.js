const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

const sports = [
    'cricket_ipl',
    'cricket_psl',
    'cricket_test_match',
    'cricket_odi',
    'cricket_international_t20'
];

async function debugScores() {
    console.log('--- Debugging Scores ---');
    for (const sport of sports) {
        try {
            console.log(`Checking ${sport}...`);
            const res = await axios.get(`${BASE_URL}/sports/${sport}/scores`, {
                params: { apiKey: API_KEY }
            });
            console.log(`Found ${res.data.length} scores for ${sport}`);
            if (res.data.length > 0) {
                res.data.forEach(m => {
                   if (m.scores) {
                       console.log(`Match: ${m.home_team} vs ${m.away_team} | ID: ${m.id}`);
                       console.log(`Scores:`, JSON.stringify(m.scores));
                   }
                });
            }
        } catch (err) {
            console.error(`Error for ${sport}:`, err.message);
        }
    }
}

debugScores();
