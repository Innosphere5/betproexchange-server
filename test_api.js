const https = require('https');

// Test 1: Fetch fixtures with the new API key
const API_KEY = '47867a6c1b58b5b0c53fdf6fe4fed924';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, raw: data.substring(0, 500) });
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== Testing oddspapi API Key ===');
  console.log('API Key:', API_KEY);
  console.log('');

  // Test 1: Fixtures
  console.log('--- Test 1: Fetch Cricket Fixtures ---');
  const fixturesResult = await fetchUrl(`https://v5.oddspapi.io/en/fixtures?apiKey=${API_KEY}&sportId=27`);
  console.log('Status:', fixturesResult.status);
  if (Array.isArray(fixturesResult.data)) {
    console.log('Total fixtures:', fixturesResult.data.length);
    
    // Find a live fixture with odds
    const liveFixtures = fixturesResult.data.filter(f => f.status?.statusName === 'Live' || f.status?.live);
    console.log('Live fixtures:', liveFixtures.length);
    
    if (liveFixtures.length > 0) {
      console.log('');
      console.log('--- Test 2: Fetch Odds for Live Fixture ---');
      const testFixture = liveFixtures[0];
      const fixtureId = testFixture.fixtureId || testFixture.id;
      console.log('Testing fixture:', fixtureId, testFixture.participants?.participant1Name, 'vs', testFixture.participants?.participant2Name);
      
      const oddsResult = await fetchUrl(`https://v5.oddspapi.io/en/fixtures/odds?apiKey=${API_KEY}&fixtureId=${fixtureId}`);
      console.log('Odds Status:', oddsResult.status);
      if (oddsResult.data) {
        const oddsStr = JSON.stringify(oddsResult.data);
        console.log('Odds data length:', oddsStr.length, 'bytes');
        console.log('Odds data (first 1500 chars):', oddsStr.substring(0, 1500));
      }
    } else {
      // Try with an upcoming fixture
      const upcoming = fixturesResult.data.filter(f => f.status?.statusName !== 'Finished').slice(0, 1);
      if (upcoming.length > 0) {
        console.log('');
        console.log('--- Test 2: Fetch Odds for Upcoming Fixture ---');
        const testFixture = upcoming[0];
        const fixtureId = testFixture.fixtureId || testFixture.id;
        console.log('Testing fixture:', fixtureId, testFixture.participants?.participant1Name, 'vs', testFixture.participants?.participant2Name);
        
        const oddsResult = await fetchUrl(`https://v5.oddspapi.io/en/fixtures/odds?apiKey=${API_KEY}&fixtureId=${fixtureId}`);
        console.log('Odds Status:', oddsResult.status);
        if (oddsResult.data) {
          const oddsStr = JSON.stringify(oddsResult.data);
          console.log('Odds data length:', oddsStr.length, 'bytes');
          console.log('Odds data (first 1500 chars):', oddsStr.substring(0, 1500));
        }
      }
    }

    // Test 3: Live fixtures endpoint
    console.log('');
    console.log('--- Test 3: Fetch Live Fixtures ---');
    const liveResult = await fetchUrl(`https://v5.oddspapi.io/en/fixtures/live?apiKey=${API_KEY}&sportId=27`);
    console.log('Live Status:', liveResult.status);
    if (Array.isArray(liveResult.data)) {
      console.log('Live fixture count:', liveResult.data.length);
      liveResult.data.slice(0, 3).forEach(f => {
        console.log(' -', f.participants?.participant1Name, 'vs', f.participants?.participant2Name, '|', f.tournament?.tournamentName);
      });
    } else {
      console.log('Live data:', JSON.stringify(liveResult.data || liveResult.raw).substring(0, 500));
    }

    // Test 4: Today fixtures endpoint
    console.log('');
    console.log('--- Test 4: Fetch Today Fixtures ---');
    const todayResult = await fetchUrl(`https://v5.oddspapi.io/en/fixtures/today?apiKey=${API_KEY}&sportId=27`);
    console.log('Today Status:', todayResult.status);
    if (Array.isArray(todayResult.data)) {
      console.log('Today fixture count:', todayResult.data.length);
      todayResult.data.slice(0, 5).forEach(f => {
        console.log(' -', f.participants?.participant1Name, 'vs', f.participants?.participant2Name, '|', f.status?.statusName, '|', f.tournament?.tournamentName);
      });
    }

  } else {
    console.log('Unexpected response:', JSON.stringify(fixturesResult.data || fixturesResult.raw).substring(0, 500));
  }

  console.log('');
  console.log('=== ALL TESTS COMPLETE ===');
}

main().catch(err => console.error('FATAL:', err));
