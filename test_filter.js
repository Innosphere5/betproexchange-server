const https = require('https');

const API_KEY = '47867a6c1b58b5b0c53fdf6fe4fed924';

function fetchUrl(u) {
  return new Promise((r, j) => {
    https.get(u, s => {
      let d = '';
      s.on('data', c => d += c);
      s.on('end', () => {
        try { r(JSON.parse(d)); } catch (e) { r(d.substring(0, 500)); }
      });
    }).on('error', j);
  });
}

// Import the fixture filter
const { shouldIncludeFixture, normalizeText } = require('./services/fixtureFilter');

async function main() {
  console.log('=== Testing Fixture Filter with Live API Data ===\n');

  // Fetch all cricket fixtures
  const now = new Date();
  const nowTs = Math.floor(now.getTime() / 1000);
  const twoDaysLater = nowTs + 2 * 24 * 3600;

  const fixtures = await fetchUrl(`https://v5.oddspapi.io/en/fixtures?apiKey=${API_KEY}&sportId=27&startTimeFrom=${nowTs}&startTimeTo=${twoDaysLater}`);

  if (!Array.isArray(fixtures)) {
    console.log('Error: fixtures not an array', fixtures);
    return;
  }

  console.log(`Total fixtures from API: ${fixtures.length}`);

  const passed = [];
  const failed = [];

  for (const f of fixtures) {
    const include = shouldIncludeFixture(f, now);
    const info = {
      id: f.fixtureId || f.id,
      home: f.participants?.participant1Name,
      away: f.participants?.participant2Name,
      tournament: f.tournament?.tournamentName,
      sport: f.sport?.sportName,
      status: f.status?.statusName,
      isLive: f.status?.live,
    };
    if (include) {
      passed.push(info);
    } else {
      failed.push(info);
    }
  }

  console.log(`\nPASSED filter: ${passed.length}`);
  console.log(`FAILED filter: ${failed.length}`);

  console.log('\n--- PASSED FIXTURES ---');
  passed.forEach(f => console.log(`  ✅ ${f.home} vs ${f.away} | ${f.tournament} | ${f.status}`));

  console.log('\n--- FAILED FIXTURES (sample) ---');
  failed.slice(0, 15).forEach(f => console.log(`  ❌ ${f.home} vs ${f.away} | ${f.tournament} | ${f.sport} | ${f.status}`));

  // Now check which passed fixtures have odds
  console.log('\n--- CHECKING ODDS FOR PASSED FIXTURES ---');
  for (const f of passed.slice(0, 10)) {
    const odds = await fetchUrl(`https://v5.oddspapi.io/en/fixtures/odds?apiKey=${API_KEY}&fixtureId=${f.id}`);
    const hasOdds = odds && odds.odds && Object.keys(odds.odds).length > 0;
    const bookmakers = odds && odds.bookmakers ? Object.keys(odds.bookmakers) : [];
    console.log(`  ${hasOdds ? '💰' : '⛔'} ${f.home} vs ${f.away} | Odds: ${hasOdds ? 'YES' : 'NO'} | Bookmakers: ${bookmakers.join(', ') || 'none'}`);
  }

  // Also check some failed fixtures that might have odds
  console.log('\n--- CHECKING ODDS FOR FAILED FIXTURES (to see what we are missing) ---');
  let foundWithOdds = 0;
  for (const f of failed.slice(0, 30)) {
    const odds = await fetchUrl(`https://v5.oddspapi.io/en/fixtures/odds?apiKey=${API_KEY}&fixtureId=${f.id}`);
    const hasOdds = odds && odds.odds && Object.keys(odds.odds).length > 0;
    if (hasOdds) {
      const bookmakers = odds && odds.bookmakers ? Object.keys(odds.bookmakers) : [];
      console.log(`  ⚠️ MISSED: ${f.home} vs ${f.away} | ${f.tournament} | Bookmakers: ${bookmakers.join(', ')}`);
      foundWithOdds++;
    }
  }
  console.log(`  Found ${foundWithOdds} fixtures with odds that were BLOCKED by filter`);

  console.log('\n=== FILTER TEST COMPLETE ===');
}

main().catch(e => console.error(e));
