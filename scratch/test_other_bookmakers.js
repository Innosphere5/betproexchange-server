const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY?.trim();
const EVENT_ID = '70343210'; // Chennai Super Kings v Sunrisers Hyderabad

async function testAllBookmakers() {
    try {
        console.log("Clearing selected bookmakers...");
        await axios.put('https://api.odds-api.io/v3/bookmakers/selected/clear', null, {
            params: { apiKey: API_KEY }
        }).catch(err => {
            console.warn("Clear failed, might not be required or endpoint differs.", err.response?.data || err.message);
        });

        // Let's request a wide range of bookmakers to see which one has odds like 2.18 / 1.83
        const testBookies = 'Betfair Exchange,SingBet,Pinnacle,Bet365,Stake,1xBet,SkyExchange,Orbit Exchange';
        
        console.log(`Fetching odds with bookmakers: ${testBookies}`);
        const res = await axios.get('https://api.odds-api.io/v3/odds', {
            params: { apiKey: API_KEY, eventId: EVENT_ID, bookmakers: testBookies }
        });

        if (res.data && res.data.bookmakers) {
            console.log("Bookmakers found:");
            for (const [bm, markets] of Object.entries(res.data.bookmakers)) {
                const ml = markets.find(m => m.name === 'ML');
                if (ml && ml.odds && ml.odds.length > 0) {
                    console.log(`- ${bm}: Home(Back/Lay)=${ml.odds[0].home}/${ml.odds[0].layHome}, Away(Back/Lay)=${ml.odds[0].away}/${ml.odds[0].layAway}`);
                }
            }
        }
    } catch (err) {
        console.error('Error status:', err.response?.status);
        console.error('Error data:', err.response?.data);
    }
}

testAllBookmakers();
