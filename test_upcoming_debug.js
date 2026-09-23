const { getData } = require('./services/apiManager');
const { shouldIncludeFixture } = require('./services/fixtureFilter');

async function testFetch() {
  const now = new Date();
  const nowTs = Math.floor(now.getTime() / 1000);
  const twoDaysLater = nowTs + 2 * 24 * 3600;

  console.log('Now:', now.toISOString(), 'nowTs:', nowTs);
  const response = await getData('fixtures', {
    params: {
      startTimeFrom: nowTs,
      startTimeTo: twoDaysLater,
    }
  });

  console.log('Total fixtures in 2-day window:', response ? response.length : 0);

  if (!Array.isArray(response)) return;

  const passed = [];
  for (const f of response) {
    if (shouldIncludeFixture(f, now)) {
      passed.push(f);
    }
  }

  console.log(`Passed shouldIncludeFixture: ${passed.length}`);
  passed.forEach((f, idx) => {
    console.log(`${idx+1}. [${f.fixtureId}] ${f.participants?.participant1Name} vs ${f.participants?.participant2Name} | ${f.tournament?.tournamentName} | Start: ${new Date(f.startTime * 1000).toISOString()}`);
  });

  const engIndex = response.findIndex(f => {
    const t = JSON.stringify(f).toLowerCase();
    return t.includes('england') && t.includes('sri lanka');
  });
  console.log('\nIndex of England vs Sri Lanka in full response:', engIndex);
  if (engIndex >= 0) {
    const f = response[engIndex];
    console.log('England vs Sri Lanka details:', {
      fixtureId: f.fixtureId,
      tournament: f.tournament?.tournamentName,
      startTime: f.startTime,
      date: new Date(f.startTime * 1000).toISOString(),
      shouldInclude: shouldIncludeFixture(f, now)
    });
  }
}

testFetch().catch(console.error);
