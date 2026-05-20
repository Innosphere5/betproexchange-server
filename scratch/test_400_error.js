const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY?.trim();
const EVENT_ID = '69657'; 

async function testEvent() {
    try {
        console.log(`Fetching full data for Event ${EVENT_ID}...`);
        const res = await axios.get('https://api.odds-api.io/v3/odds', {
            params: { apiKey: API_KEY, eventId: EVENT_ID, bookmakers: 'Betfair Exchange,Bet365,12bet,Orbit Exchange,SkyExchange' }
        });


        console.log('Response:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.error('Error status:', err.response?.status);
        console.error('Error data:', err.response?.data);
    }
}

testEvent();
