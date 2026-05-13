const mongoose = require('mongoose');
require('dotenv').config();
const oddsApiService = require('../services/oddsApiService');

async function debugRawEvents() {
    try {
        console.log('Fetching raw events from Odds API...');
        const data = await oddsApiService.fetch('events', { sport: 'cricket', status: 'pending,live' });
        
        if (Array.isArray(data)) {
            console.log(`Total events: ${data.length}`);
            const keywords = ['Kolkata', 'Bengaluru', 'Bangalore', 'Mumbai', 'Punjab', 'IPL', 'Pakistan', 'Zimbabwe'];
            
            data.forEach(event => {
                const text = `${event.home} v ${event.away} (${event.league || ''})`.toLowerCase();
                if (keywords.some(k => text.includes(k.toLowerCase()))) {
                    console.log(`MATCHED KEYWORD: ${event.home} v ${event.away} | Date: ${event.date} | ID: ${event.id}`);
                }
            });
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

debugRawEvents();
