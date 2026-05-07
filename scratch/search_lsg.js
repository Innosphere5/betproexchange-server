const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY?.trim();

async function searchEvents() {
    try {
        console.log('Fetching all events...');
        const res = await axios.get('https://api.odds-api.io/v3/events', {
            params: { apiKey: API_KEY, sport: 'cricket', status: 'pending,live' }
        });
        
        const events = res.data;
        console.log(`Found ${events.length} events.`);
        
        const filtered = events.filter(e => 
            e.home.toLowerCase().includes('lucknow') || 
            e.away.toLowerCase().includes('lucknow') ||
            e.home.toLowerCase().includes('bengaluru') ||
            e.away.toLowerCase().includes('bengaluru') ||
            e.home.toLowerCase().includes('bangalore') ||
            e.away.toLowerCase().includes('bangalore')
        );
        
        console.log('Matches for LSG/RCB:', JSON.stringify(filtered, null, 2));
    } catch (err) {
        console.error(err.message);
    }
}

searchEvents();
