const axios = require('axios');
require('dotenv').config();

async function testKey(keyName, keyValue) {
    const paramsOptions = [
        { apiKey: keyValue },
        { apikey: keyValue },
        { api_key: keyValue },
        { token: keyValue }
    ];

    console.log(`\nTesting Key: ${keyName} (${keyValue.substring(0, 5)}...)`);
    for (const params of paramsOptions) {
        const paramKey = Object.keys(params)[0];
        try {
            const res = await axios.get('https://api.odds-api.io/v3/events', { params });
            console.log(`✅ SUCCESS with ${paramKey}! Status: ${res.status}`);
            return;
        } catch (err) {
            console.log(`❌ FAILED with ${paramKey}: ${err.response ? err.response.status : err.message}`);
        }
    }
}

async function run() {
    await testKey('ODDS_API_KEY', process.env.ODDS_API_KEY || '');
    await testKey('API_KEY', process.env.API_KEY || '');
}

run();
