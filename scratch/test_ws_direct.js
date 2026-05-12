const WebSocket = require('ws');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const WS_URL = `wss://api.odds-api.io/v3/ws?apiKey=${API_KEY}&sport=cricket&markets=ML&status=live,prematch`;

console.log('Testing Odds-API WebSocket Connection...');
console.log('URL:', WS_URL.replace(API_KEY, 'HIDDEN'));

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('✅ WebSocket Connected');
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    console.log('📩 Message Received:', msg.type);
    if (msg.type === 'created' || msg.type === 'updated') {
        const events = Array.isArray(msg.data) ? msg.data : [msg.data];
        events.forEach(event => {
            console.log(`📍 Event: ${event.home} v ${event.away} | Status: ${event.status}`);
            if (event.bookmakers) {
                Object.entries(event.bookmakers).forEach(([bm, markets]) => {
                    const ml = markets.find(m => m.name === 'ML');
                    if (ml) {
                        console.log(`   💰 ${bm} ML:`, ml.odds[0]);
                    }
                });
            }
        });
    }
});

ws.on('error', (err) => {
    console.error('❌ Error:', err.message);
});

ws.on('close', () => {
    console.log('🚪 Connection Closed');
});

// Close after 10 seconds of testing
setTimeout(() => {
    console.log('Test finished. Closing...');
    ws.close();
    process.exit(0);
}, 10000);
