const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://v5.oddspapi.io/en';
const FIXTURE_ID = 'id2702721269625676'; // England vs Australia T20 W

async function checkCurrentOdds() {
    try {
        console.log(`Fetching current odds for fixture ${FIXTURE_ID} from OddsPapi...`);
        const res = await axios.get(`${BASE_URL}/fixtures/odds`, {
            params: { apiKey: API_KEY, fixtureId: FIXTURE_ID, bookmakers: 'pinnacle,betfair-ex' },
            timeout: 10000
        });
        
        console.log('Odds keys returned:', Object.keys(res.data.odds || {}));
        
        if (res.data.odds) {
            for (const [bk, markets] of Object.entries(res.data.odds)) {
                console.log(`\n=== Bookmaker: ${bk} ===`);
                for (const [oddId, val] of Object.entries(markets)) {
                    console.log(`  OutcomeId: ${val.outcomeId} | MarketId: ${val.marketId} | Price: ${val.price} | Active: ${val.active} | Limit: ${val.limit} | ChangedAt: ${new Date(val.changedAt || val.changed_at)}`);
                }
            }
        } else {
            console.log('No odds field in response.');
        }
    } catch (err) {
        console.error('Error:', err.response ? err.response.data : err.message);
    }
}

checkCurrentOdds();
