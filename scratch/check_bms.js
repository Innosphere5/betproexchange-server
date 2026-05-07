const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY?.trim();

async function checkBMs() {
    try {
        const res = await axios.get('https://api.odds-api.io/v3/bookmakers', {
            params: { apiKey: API_KEY }
        });
        console.log('Valid Bookmakers:', res.data.map(b => b.name).join(', '));
    } catch (err) {
        console.error(err.response ? err.response.data : err.message);
    }
}

checkBMs();
