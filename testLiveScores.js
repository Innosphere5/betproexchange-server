const axios = require('axios');
require('dotenv').config();

async function testLiveScores() {
  try {
    console.log("Fetching live cricket fixtures from oddspapi...");
    const res = await axios.get('https://v5.oddspapi.io/en/fixtures/live', {
      params: { 
        apiKey: process.env.ODDS_API_KEY,
        sportId: 27
      }
    });
    
    const matches = res.data;
    console.log(`Live matches found: ${matches.length}`);
    
    if (matches.length > 0) {
      matches.forEach(m => {
        const p1 = m.participants?.participant1Name || 'Team 1';
        const p2 = m.participants?.participant2Name || 'Team 2';
        const p1Score = m.scores?.result?.participant1Score || 0;
        const p2Score = m.scores?.result?.participant2Score || 0;
        console.log(`Match ID: ${m.fixtureId} | ${p1} vs ${p2} | Tournament: ${m.tournament?.tournamentName} | Status: ${m.status?.statusName}`);
        console.log(`  Scores: ${p1} ${p1Score} - ${p2Score} ${p2}`);
      });
    }

  } catch (error) {
    console.error("Error fetching live scores:", error.response?.status, error.response?.data || error.message);
  }
}

testLiveScores();
