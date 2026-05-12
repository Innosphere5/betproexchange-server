const WebSocket = require('ws');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;

// Variation 1: User's provided URL
const url1 = `wss://api.odds-api.io/v3/ws?apiKey=${API_KEY}&sport=cricket&markets=ML&status=live,prematch`;

// Variation 2: Simpler URL
const url2 = `wss://api.odds-api.io/v3/ws?apiKey=${API_KEY}&markets=h2h`;

async function test(url, name) {
    console.log(`Testing ${name}...`);
    return new Promise((resolve) => {
        const ws = new WebSocket(url);
        let connected = false;

        ws.on('open', () => {
            console.log(`✅ [${name}] Connected`);
            connected = true;
            ws.close();
            resolve(true);
        });

        ws.on('error', (err) => {
            console.error(`❌ [${name}] Error:`, err.message);
            resolve(false);
        });

        ws.on('close', () => {
            if (!connected) console.log(`🚪 [${name}] Connection Failed/Closed`);
        });

        setTimeout(() => {
            if (!connected) {
                console.log(`⏱️ [${name}] Timeout`);
                ws.terminate();
                resolve(false);
            }
        }, 5000);
    });
}

(async () => {
    await test(url1, 'User Provided URL');
    await test(url2, 'Simple h2h URL');
    process.exit(0);
})();
