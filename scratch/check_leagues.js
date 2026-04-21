const axios = require('axios');
require('dotenv').config({ path: 'c:/Users/vikas/OneDrive/Desktop/betproexchange-site/backend/betproexchange-server/.env' });

const API_TOKEN = process.env.API_KEY;
const BASE_URL  = 'https://cricket.sportmonks.com/api/v2.0';

async function checkLeagues() {
    try {
        console.log('Fetching leagues from Sportmonks...');
        const response = await axios.get(`${BASE_URL}/leagues`, {
            params: { api_token: API_TOKEN }
        });

        if (response.data && response.data.data) {
            console.log('Available Leagues:');
            response.data.data.forEach(league => {
                console.log(`ID: ${league.id} | Name: ${league.name}`);
            });
        } else {
            console.log('No league data found.');
        }
    } catch (err) {
        console.error('Error fetching leagues:', err.message);
        if (err.response) {
            console.error('Response:', JSON.stringify(err.response.data, null, 2));
        }
    }
}

checkLeagues();
