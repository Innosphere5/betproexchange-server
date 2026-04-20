const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

async function fetchLiveScore(sport) {
    try {
        const res = await axios.get(`${BASE_URL}/sports/${sport}/scores`, {
            params: { apiKey: API_KEY }
        });
        if (res.data.length > 0) {
            console.log(`--- ${sport} ---`);
            res.data.slice(0, 2).forEach(m => {
                console.log(`Match: ${m.home_team} vs ${m.away_team}`);
                console.log(`ID: ${m.id}`);
                console.log(`Scores:`, JSON.stringify(m.scores, null, 2));
            });
        }
    } catch (err) {}
}

async function run() {
    await fetchLiveScore('cricket_ipl');
    await fetchLiveScore('cricket_psl');
    await fetchLiveScore('cricket_odi');
    await fetchLiveScore('cricket_international_t20');
}

run();
