const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY?.trim();
const EVENT_ID = '71098768'; // Malta v Gibraltar

async function testEvent() {
    try {
        console.log(`Fetching full data for Event ${EVENT_ID}...`);
        const res = await axios.get('https://api.odds-api.io/v3/odds', {
            params: { apiKey: API_KEY, eventId: EVENT_ID, bookmakers: 'Bet365,1xbet,SingBet,SkyExchange,Betfair Exchange' }
        });


        console.log('Response:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.error(err.response ? err.response.data : err.message);
    }
}

testEvent();
