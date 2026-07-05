require('dotenv').config();
const oddsApiRest = require('../services/oddsApiRest');

async function test() {
    try {
        const fixtureId = 'id2702721269625566'; // South Africa v India
        console.log(`Fetching odds for fixture: ${fixtureId}...`);
        const res = await oddsApiRest.getFixtureOdds(fixtureId);
        console.log('Result structure keys:', Object.keys(res || {}));
        console.log('Full Result (JSON):', JSON.stringify(res, null, 2));
    } catch (err) {
        console.error('Error fetching odds:', err.response?.data || err.message);
    }
}

test();
