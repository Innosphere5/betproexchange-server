const WebSocket = require('ws');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const WS_URL = `wss://api.odds-api.io/v3/ws?apiKey=${API_KEY}&sport=cricket&markets=ML`;

console.log(`Connecting to ${WS_URL}...`);
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('✅ Connected!');
    setTimeout(() => {
        console.log('Closing after 5s...');
        ws.close();
        process.exit(0);
    }, 5000);
});

ws.on('message', (data) => {
    console.log('Received:', data.toString().substring(0, 200));
});

ws.on('error', (err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

ws.on('close', () => {
    console.log('Closed.');
});
