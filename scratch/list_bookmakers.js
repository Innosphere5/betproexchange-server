const oddsApiService = require('../services/oddsApiService');
require('dotenv').config();

async function listBookmakers() {
    try {
        const data = await oddsApiService.fetch('odds', { 
            eventId: '70343198'
        });
        
        if (data && data.bookmakers) {
            console.log('Bookmakers found:', Object.keys(data.bookmakers).join(', '));
            Object.keys(data.bookmakers).forEach(bm => {
                const ml = data.bookmakers[bm].find(m => m.name === 'ML' || m.name === 'Match Winner' || m.name === 'h2h');
                if (ml) {
                    console.log(`[${bm}] ML Found:`, JSON.stringify(ml.odds[0]));
                }
            });
        } else {
            console.log('No bookmakers in response.');
        }
    } catch (err) {
        console.error(err);
    }
}

listBookmakers();
