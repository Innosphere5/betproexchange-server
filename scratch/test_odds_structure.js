const oddsApiService = require('../services/oddsApiService');
require('dotenv').config();

async function testOddsStructure() {
    try {
        console.log('Fetching odds for RCB v KKR (ID 70343198)...');
        const data = await oddsApiService.fetch('odds', { 
            eventId: '70343198',
            bookmakers: '1xbet,Bet365,Stake'
        });
        
        console.log('API Response:', JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(err);
    }
}

testOddsStructure();
