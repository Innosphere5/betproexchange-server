const https = require('https');

const API_KEY = '47867a6c1b58b5b0c53fdf6fe4fed924';

function fetchUrl(u) {
  return new Promise((resolve, reject) => {
    https.get(u, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('Fetching fixtures from oddspapi without date restriction...');
  const fixtures = await fetchUrl(`https://v5.oddspapi.io/en/fixtures?apiKey=${API_KEY}&sportId=27`);
  
  if (!Array.isArray(fixtures)) {
    console.error('Not an array:', fixtures);
    return;
  }
  
  console.log(`Total fixtures: ${fixtures.length}`);
  
  const engSlMatches = fixtures.filter(f => {
    const text = JSON.stringify(f).toLowerCase();
    return (text.includes('england') && text.includes('sri lanka')) || text.includes('sri lanka') || text.includes('england');
  });

  console.log(`Matches mentioning England or Sri Lanka: ${engSlMatches.length}`);
  for (const m of engSlMatches) {
    console.log({
      fixtureId: m.fixtureId || m.id,
      tournament: m.tournament?.tournamentName,
      tournamentId: m.tournament?.tournamentId,
      participant1: m.participants?.participant1Name,
      participant2: m.participants?.participant2Name,
      startTime: m.startTime,
      date: new Date(m.startTime * 1000).toISOString(),
      status: m.status?.statusName
    });
    
    // Check odds for this fixture
    const odds = await fetchUrl(`https://v5.oddspapi.io/en/fixtures/odds?apiKey=${API_KEY}&fixtureId=${m.fixtureId || m.id}`);
    console.log('Odds available bookmakers:', odds && odds.bookmakers ? Object.keys(odds.bookmakers) : 'None');
    if (odds && odds.odds) {
      console.log('Sample odds:', JSON.stringify(odds.odds).substring(0, 300));
    }
  }

  // Let's also check all unique tournaments
  const tournaments = new Map();
  for (const f of fixtures) {
    const tName = f.tournament?.tournamentName || 'Unknown';
    tournaments.set(tName, (tournaments.get(tName) || 0) + 1);
  }
  console.log('\nTop Tournaments in API:');
  const sortedT = Array.from(tournaments.entries()).sort((a,b) => b[1] - a[1]);
  for (const [t, count] of sortedT.slice(0, 25)) {
    console.log(`- ${t} (${count} matches)`);
  }
}

run();
