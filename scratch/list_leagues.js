const axios = require('axios');
require('dotenv').config();

const API_TOKEN = process.env.API_KEY;
const BASE_URL = 'https://cricket.sportmonks.com/api/v2.0';

async function listLeagues() {
    try {
        const response = await axios.get(`${BASE_URL}/leagues`, {
            params: { api_token: API_TOKEN }
        });
        
        console.log('Leagues found:');
        response.data.data.forEach(league => {
            console.log(`ID: ${league.id} | Name: ${league.name}`);
        });
    } catch (error) {
        console.error('Error fetching leagues:', error.message);
    }
}

listLeagues();
