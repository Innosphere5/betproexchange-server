const WebSocket = require('ws');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const WS_URL = `wss://api.odds-api.io/v3/ws?apiKey=${API_KEY}&sport=cricket&markets=ML&status=live&status=prematch`;

console.log('Logging all Odds-API messages for 30s...');
const ws = new WebSocket(WS_URL);

let count = 0;
ws.on('message', (data) => {
    const str = data.toString();
    if (count < 10) {
        console.log('RAW MESSAGE:', str.substring(0, 500));
        count++;
    }
});

setTimeout(() => {
    console.log('Done.');
    ws.close();
    process.exit(0);
}, 30000);
