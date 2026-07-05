const WebSocket = require('ws');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const WS_URL = 'wss://v5.oddspapi.io/ws';

const ws = new WebSocket(WS_URL);
const bookmakersSeen = new Set();
let oddsCount = 0;

ws.on('open', () => {
    console.log('Connected. Sending login (pinnacle + betfair-ex)...');
    ws.send(JSON.stringify({
        type: 'login',
        apiKey: API_KEY,
        channels: ['odds'],
        sportIds: [27],
        bookmakers: ['pinnacle', 'betfair-ex'],
        receiveType: 'json'
    }));
});

ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'login_ok') {
        console.log('Login OK!');
        setTimeout(() => {
            console.log(`\n=== SUMMARY after 20s ===`);
            console.log(`Total odds updates: ${oddsCount}`);
            console.log(`Bookmakers seen: ${Array.from(bookmakersSeen).join(', ')}`);
            ws.close();
            process.exit(0);
        }, 20000);
    }

    if (msg.channel === 'odds' && msg.payload) {
        oddsCount++;
        const odds = msg.payload.odds || {};
        for (const bk of Object.keys(odds)) {
            if (!bookmakersSeen.has(bk)) {
                bookmakersSeen.add(bk);
                console.log(`NEW BOOKMAKER SEEN: ${bk}`);
                const oddsMap = odds[bk];
                const firstKey = Object.keys(oddsMap)[0];
                if (firstKey) {
                    console.log(`  Sample: ${JSON.stringify(oddsMap[firstKey], null, 2)}`);
                }
            }
        }
    }
});

ws.on('close', () => console.log('Closed.'));
ws.on('error', (err) => console.error('Error:', err.message));
