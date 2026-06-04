/**
 * Discovery script to verify OddsPapi API connectivity
 * and list available cricket sports/tournaments.
 *
 * Usage: node scripts/discoverCricketSportId.js
 */
const oddsPapiRest = require('../services/oddsPapiRest');

async function discover() {
    console.log('=== OddsPapi v5 Discovery ===\n');

    try {
        // 1. Verify API key by fetching sports
        console.log('1) Fetching sports...');
        const sports = await oddsPapiRest.getSports();

        if (Array.isArray(sports)) {
            console.log(`   Found ${sports.length} sports:`);
            for (const s of sports) {
                const marker = s.sportId === 27 ? ' ← CRICKET' : '';
                console.log(`   - ${s.sportName} (id: ${s.sportId}, slug: ${s.slug})${marker}`);
            }
        } else {
            console.log('   Response:', JSON.stringify(sports, null, 2));
        }

        // 2. Fetch cricket tournaments
        console.log('\n2) Fetching cricket tournaments (sportId: 27)...');
        const tournaments = await oddsPapiRest.getTournaments(27);

        if (Array.isArray(tournaments)) {
            console.log(`   Found ${tournaments.length} cricket tournaments:`);
            for (const t of tournaments.slice(0, 20)) {
                console.log(`   - ${t.tournamentName} (id: ${t.tournamentId}, category: ${t.categoryName || 'N/A'})`);
            }
            if (tournaments.length > 20) {
                console.log(`   ... and ${tournaments.length - 20} more`);
            }
        } else {
            console.log('   Response:', JSON.stringify(tournaments, null, 2));
        }

        // 3. Fetch today's cricket fixtures
        console.log('\n3) Fetching today\'s cricket fixtures...');
        const fixtures = await oddsPapiRest.getFixturesToday({
            sportId: 27,
            bookmakers: 'betfair-ex,pinnacle'
        });

        if (Array.isArray(fixtures)) {
            console.log(`   Found ${fixtures.length} fixtures today:`);
            for (const f of fixtures.slice(0, 10)) {
                const p = f.participants || {};
                const status = f.status?.live ? 'LIVE' : f.status?.statusName || 'upcoming';
                const bks = f.bookmakers ? Object.keys(f.bookmakers).join(', ') : 'none';
                console.log(`   - [${status}] ${p.participant1Name || '?'} v ${p.participant2Name || '?'} (fixture: ${f.fixtureId})`);
                console.log(`     Bookmakers: ${bks}`);
            }
        } else {
            console.log('   Response:', JSON.stringify(fixtures, null, 2));
        }

        console.log('\n=== Discovery Complete ===');
    } catch (err) {
        console.error('Discovery failed:', err.response?.data || err.message);
    }
}

discover();
