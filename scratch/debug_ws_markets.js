const WebSocket = require('ws');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const WS_URL = `wss://api.odds-api.io/v3/ws?apiKey=${API_KEY}&sport=cricket&markets=ML`;

console.log(`Connecting to ${WS_URL}...`);
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('✅ Connected!');
});

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'updated' || msg.type === 'created') {
        const events = Array.isArray(msg.data) ? msg.data : [msg.data || msg];
        events.forEach(event => {
            if (event.home) {
                console.log(`Event: ${event.home} v ${event.away}`);
                if (event.markets) {
                    console.log('Markets:', event.markets.map(m => m.name).join(', '));
                    const ml = event.markets.find(m => m.name === 'ML' || m.name === 'Match Winner' || m.name === 'h2h');
                    if (ml) {
                        console.log('  ML Odds:', JSON.stringify(ml.odds));
                    }
                }
            }
        });
    }
});

ws.on('error', (err) => {
    console.error('❌ Error:', err.message);
});

setTimeout(() => {
    console.log('Closing...');
    ws.close();
    process.exit(0);
}, 10000);
