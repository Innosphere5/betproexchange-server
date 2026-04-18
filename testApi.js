const axios = require('axios');

async function test() {
  const API_KEY = 'd39745ccfdd9ad9dce70dd6dd8d0fb550962c07d918d258d5a029e0dec701761';
  try {
    const res = await axios.get('https://api.odds-api.io/v3/events', {
      params: { apiKey: API_KEY, sport: 'cricket' }
    });
    console.log("TOTAL EVENTS:", res.data.length);
    console.log("SAMPLE DATES:");
    res.data.slice(0, 5).forEach(e => {
       console.log(`- ${e.home} vs ${e.away} | Date: ${e.date}`);
    });
    
    // find upcoming or live
    const now = new Date();
    const upcoming = res.data.filter(e => new Date(e.date) >= now);
    console.log("TOTAL UPCOMING:", upcoming.length);
    if (upcoming.length > 0) {
      console.log("UPCOMING SAMPLE:", upcoming[0]);
    }
  } catch(e) {
    console.error(e.message);
  }
}
test();
