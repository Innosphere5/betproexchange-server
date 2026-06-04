/**
 * Quick WebSocket connectivity test for OddsPapi v5.
 * Tests login, fixture updates, and odds updates.
 *
 * Usage: node scripts/testOddsPapiWs.js
 */
const WebSocket = require('ws');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const WS_URL = 'wss://v5.oddspapi.io/ws';

const ws = new WebSocket(WS_URL);
let messageCount = 0;
let oddsCount = 0;
let fixtureCount = 0;

ws.on('open', () => {
    console.log('✅ WebSocket connected. Sending login...');

    ws.send(JSON.stringify({
        type: 'login',
        apiKey: API_KEY,
        channels: ['fixtures', 'odds', 'scores', 'bookmakers'],
        sportIds: [27],
        bookmakers: ['betfair-ex', 'pinnacle'],
        receiveType: 'json',
        lang: 'en'
    }));
});

ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    messageCount++;

    if (msg.type === 'login_ok') {
        console.log('✅ Login OK!');
        console.log('   Access:', JSON.stringify(msg.access));
        console.log('   Channels:', msg.channels);
        console.log('   Resume:', JSON.stringify(msg.resume));
        console.log('\n🎯 Waiting for data messages (will auto-close after 15s)...\n');

        // Auto close after 15 seconds
        setTimeout(() => {
            console.log(`\n=== Test Summary ===`);
            console.log(`Total messages: ${messageCount}`);
            console.log(`Fixture updates: ${fixtureCount}`);
            console.log(`Odds updates: ${oddsCount}`);
            console.log(`==================\n`);
            ws.close();
            process.exit(0);
        }, 15000);
    }

    if (msg.type === 'login_failed') {
        console.error('❌ Login failed:', JSON.stringify(msg));
        ws.close();
        process.exit(1);
    }

    if (msg.channel === 'fixtures' && msg.payload) {
        fixtureCount++;
        const p = msg.payload.participants || {};
        const status = msg.payload.status?.live ? 'LIVE' : 'PRE';
        console.log(`📋 [fixture] [${status}] ${p.participant1Name || '?'} v ${p.participant2Name || '?'} (${msg.payload.fixtureId})`);
    }

    if (msg.channel === 'odds' && msg.payload) {
        oddsCount++;
        const fixtureId = msg.payload.fixtureId;
        const odds = msg.payload.odds || {};
        const bookmakers = Object.keys(odds);

        for (const bk of bookmakers) {
            const oddsMap = odds[bk];
            const oddsIds = Object.keys(oddsMap);
            const first = oddsMap[oddsIds[0]];
            if (first) {
                console.log(`💰 [odds] ${bk} | fixture: ${fixtureId} | price: ${first.price} | active: ${first.active} | outcomes: ${oddsIds.length}`);

                // Show meta for betfair-ex
                if (bk === 'betfair-ex' && first.meta) {
                    const back = first.meta.back || [];
                    const lay = first.meta.lay || [];
                    console.log(`   📊 Exchange: back=[${back.map(b => `${b.price}@${b.size}`).join(', ')}] lay=[${lay.map(l => `${l.price}@${l.size}`).join(', ')}]`);
                }
            }
        }
    }

    if (msg.channel === 'scores' && msg.payload) {
        const scores = msg.payload.scores || {};
        const result = scores.result;
        if (result) {
            console.log(`📊 [scores] ${msg.payload.fixtureId} — ${result.participant1Score} v ${result.participant2Score}`);
        }
    }

    if (msg.channel === 'bookmakers' && msg.payload) {
        const bks = msg.payload.bookmakers || {};
        for (const [bk, meta] of Object.entries(bks)) {
            console.log(`📌 [bookmaker] ${bk} | hasOdds: ${meta.hasOdds} | stale: ${meta.staleOdds} | suspended: ${meta.suspended}`);
        }
    }
});

ws.on('close', (code) => {
    console.log(`WebSocket closed (code: ${code})`);
});

ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
});
