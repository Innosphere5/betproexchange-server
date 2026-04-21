const axios = require('axios');
require('dotenv').config({ path: 'c:/Users/vikas/OneDrive/Desktop/betproexchange-site/backend/betproexchange-server/.env' });

const API_TOKEN = process.env.API_KEY;
const BASE_URL  = 'https://cricket.sportmonks.com/api/v2.0';

async function checkFixtures() {
    try {
        const today = new Date().toISOString().split('T')[0];
        console.log(`Checking fixtures for: ${today}`);
        
        const response = await axios.get(`${BASE_URL}/fixtures`, {
            params: { 
                api_token: API_TOKEN,
                'filter[starts_between]': `${today},${today}`
            }
        });

        if (response.data && response.data.data) {
            console.log(`Found ${response.data.data.length} matches today.`);
            response.data.data.forEach(f => {
                console.log(`ID: ${f.id} | LeagueID: ${f.league_id} | Status: ${f.status} | Time: ${f.starting_at}`);
            });
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
}

checkFixtures();
