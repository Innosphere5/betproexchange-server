const oddsApiService = require('../services/oddsApiService');
require('dotenv').config();

async function findMLMarket() {
    try {
        const data = await oddsApiService.fetch('odds', { 
            eventId: '70343198',
            bookmakers: '1xbet'
        });
        
        if (data && data.bookmakers && data.bookmakers['1xbet']) {
            const ml = data.bookmakers['1xbet'].find(m => m.name === 'ML' || m.name === 'Match Winner' || m.name === 'h2h' || m.name === 'Full Time Result');
            if (ml) {
                console.log('ML Market Found!');
                console.log(JSON.stringify(ml, null, 2));
            } else {
                console.log('ML Market NOT found. Available markets:');
                console.log(data.bookmakers['1xbet'].map(m => m.name).join(', '));
            }
        } else {
            console.log('No 1xbet data.');
        }
    } catch (err) {
        console.error(err);
    }
}

findMLMarket();
