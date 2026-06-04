/**
 * Deep odds inspection for OddsPapi v5.
 * Logs the full structure of odds updates to understand the data shape.
 *
 * Usage: node scripts/inspectOddsStructure.js
 */
const WebSocket = require('ws');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const WS_URL = 'wss://v5.oddspapi.io/ws';

const ws = new WebSocket(WS_URL);
let oddsCount = 0;

ws.on('open', () => {
    console.log('Connected. Sending login...');
    ws.send(JSON.stringify({
        type: 'login',
        apiKey: API_KEY,
        channels: ['fixtures', 'odds'],
        sportIds: [27],
        bookmakers: ['betfair-ex', 'pinnacle'],
        receiveType: 'json',
        lang: 'en'
    }));
});

ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === 'login_ok') {
        console.log('Login OK! Waiting for odds...\n');
        setTimeout(() => { ws.close(); process.exit(0); }, 20000);
    }

    // Log first few full odds structures
    if (msg.channel === 'odds' && msg.payload) {
        oddsCount++;
        if (oddsCount <= 5) {
            console.log(`\n=== ODDS UPDATE #${oddsCount} ===`);
            console.log('Fixture:', msg.payload.fixtureId);
            
            const odds = msg.payload.odds || {};
            for (const [bk, oddsMap] of Object.entries(odds)) {
                console.log(`\nBookmaker: ${bk}`);
                for (const [oddsId, quote] of Object.entries(oddsMap)) {
                    console.log(`  OddsId: ${oddsId}`);
                    console.log(`    outcomeId: ${quote.outcomeId}`);
                    console.log(`    playerId: ${quote.playerId}`);
                    console.log(`    price: ${quote.price}`);
                    console.log(`    active: ${quote.active}`);
                    console.log(`    marketActive: ${quote.marketActive}`);
                    console.log(`    mainLine: ${quote.mainLine}`);
                    console.log(`    marketId: ${quote.marketId}`);
                    console.log(`    priceFractional: ${quote.priceFractional}`);
                    console.log(`    priceAmerican: ${quote.priceAmerican}`);
                    console.log(`    limit: ${quote.limit}`);
                    console.log(`    changedAt: ${quote.changedAt}`);
                    console.log(`    meta: ${JSON.stringify(quote.meta)}`);
                    console.log(`    betslip: ${quote.betslip}`);
                }
            }
        }
    }

    // Also log fixture updates for participant info
    if (msg.channel === 'fixtures' && msg.payload) {
        const p = msg.payload.participants || {};
        console.log(`\n📋 FIXTURE: ${p.participant1Name} v ${p.participant2Name}`);
        console.log(`   fixtureId: ${msg.payload.fixtureId}`);
        console.log(`   status: ${JSON.stringify(msg.payload.status)}`);
        console.log(`   startTime: ${msg.payload.startTime}`);
    }
});

ws.on('close', () => console.log('Closed.'));
ws.on('error', (err) => console.error('Error:', err.message));
