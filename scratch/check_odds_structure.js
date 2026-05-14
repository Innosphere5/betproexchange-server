const axios = require('axios');
require('dotenv').config();

async function checkOdds() {
    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) {
        console.error('Missing ODDS_API_KEY');
        return;
    }

    const baseUrl = 'https://api.odds-api.io/v3';
    
    try {
        console.log('Fetching events...');
        const eventsRes = await axios.get(`${baseUrl}/events`, {
            params: { apiKey, sport: 'cricket', status: 'live' }
        });
        
        console.log('Live events found:', eventsRes.data.length);
        if (eventsRes.data.length > 0) {
            const eventId = eventsRes.data[0].id;
            console.log(`Fetching odds for event ${eventId} (${eventsRes.data[0].home} v ${eventsRes.data[0].away})...`);
            
            const oddsRes = await axios.get(`${baseUrl}/odds`, {
                params: { apiKey, eventId, bookmakers: 'Betfair Exchange' }
            });
            
            console.log('Odds Data:', JSON.stringify(oddsRes.data, null, 2));
        } else {
            console.log('No live events found to test odds.');
        }
    } catch (err) {
        console.error('Error:', err.response?.status, err.response?.data || err.message);
    }
}

checkOdds();
