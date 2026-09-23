const { getData } = require('./services/apiManager');

async function testFixtures() {
  const nowTs = Math.floor(Date.now() / 1000);
  const fixtures = await getData('fixtures', {
    params: {
      startTimeFrom: nowTs,
      startTimeTo: nowTs + 7 * 24 * 3600
    }
  });

  console.log(`Fetched ${fixtures.length} fixtures in 7-day window.\n`);

  for (const f of fixtures) {
    const tName = f.tournament?.tournamentName || '';
    const p1 = f.participants?.participant1Name || '';
    const p2 = f.participants?.participant2Name || '';
    const isLive = f.status?.live;
    const start = new Date(f.startTime * 1000).toISOString();
    console.log(`[${f.fixtureId}] ${p1} vs ${p2} | ${tName} | ${isLive ? 'LIVE' : 'UPCOMING'} | ${start}`);
  }
}

testFixtures().catch(console.error);
