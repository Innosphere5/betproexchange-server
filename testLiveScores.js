const axios = require('axios');
require('dotenv').config();

async function testLiveScores() {
  try {
    console.log("Fetching livescores from Sportmonks...");
    const res = await axios.get('https://cricket.sportmonks.com/api/v2.0/livescores', {
      params: { 
        api_token: process.env.API_KEY,
        include: 'runs,balls,scoreboards,localteam,visitorteam'
      }
    });
    
    const matches = res.data.data;
    console.log(`Live matches found: ${matches.length}`);
    
    if (matches.length > 0) {
      matches.forEach(m => {
        console.log(`Match ID: ${m.id} | ${m.localteam?.name} vs ${m.visitorteam?.name} | League ID: ${m.league_id} | Status: ${m.status}`);
        console.log(`  Runs:`, JSON.stringify(m.runs?.map(r => ({ team: r.team_id, score: r.score, wickets: r.wickets, overs: r.overs }))));
      });
    }

  } catch (error) {
    console.error("Error fetching livescores:", error.message);
  }
}

testLiveScores();
