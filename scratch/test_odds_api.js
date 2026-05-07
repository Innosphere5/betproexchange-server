const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.odds-api.io/v3';

async function testApi() {
  try {
    console.log('Testing Odds API...');
    const eventsResponse = await axios.get(`${BASE_URL}/events`, {
      params: { apiKey: API_KEY, sport: 'cricket', status: 'pending,live' },
      timeout: 10000
    });

    console.log('Events response status:', eventsResponse.status);
    console.log('Total events:', eventsResponse.data.length);
    try {
        console.log('Fetching Bookmakers...');
        const bmResponse = await axios.get(`${BASE_URL}/bookmakers`, {
            params: { apiKey: API_KEY },
            timeout: 10000
        });
        console.log('Bookmakers:', bmResponse.data.length);
        if (bmResponse.data.length > 0) {
            console.log('Bookmaker Names:', bmResponse.data.slice(0, 50).map(b => b.name).join(', '));
        }
    } catch (e) {
        console.log('Bookmakers endpoint failed or not available:', e.message);
    }

    if (eventsResponse.data.length > 0) {
        const iplMatch = eventsResponse.data.find(e => e.league.name.includes('IPL') || e.home.includes('Lucknow') || e.away.includes('Lucknow'));
        if (iplMatch) {
            console.log(`\n--- Found IPL Match: ${iplMatch.home} v ${iplMatch.away} (ID: ${iplMatch.id}) ---`);
            try {
                const oddsResponse = await axios.get(`${BASE_URL}/odds/multi`, {
                  params: {
                    apiKey: API_KEY,
                    eventIds: iplMatch.id,
                    bookmakers: 'Bet365',
                  },
                  timeout: 10000
                });
                
                console.log('Odds Found for IPL:');
                console.log(JSON.stringify(oddsResponse.data, null, 2));
            } catch (err) {
                console.error('Odds fetch failed:', err.response ? err.response.data : err.message);
            }
        } else {
            console.log('No IPL match found in events list.');
        }
    }

    const remaining = eventsResponse.headers['x-ratelimit-remaining'];
    const limit = eventsResponse.headers['x-ratelimit-limit'];
    console.log(`Rate Limit: ${remaining} / ${limit}`);

  } catch (err) {
    console.error('API Error:', err.response ? err.response.data : err.message);
  }
}

testApi();
