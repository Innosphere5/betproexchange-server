const mongoose = require('mongoose');
require('dotenv').config();

const Match = require('../models/Match');
const MarketOdds = require('../models/MarketOdds');
const OddsMarket = require('../models/OddsMarket');
const oddsApiLiveService = require('../services/oddsApiLiveService');

async function runTest() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Mock Socket.io
        const mockIo = {
            emit: (event, data) => {
                console.log(`[Socket.io EMIT] 📡 Event: ${event} | MatchId: ${data.matchId}`);
                if (data.runners) {
                    console.log(`  Runners:`, JSON.stringify(data.runners));
                } else if (data.marketStatus) {
                    console.log(`  Market Status: ${data.marketStatus}`);
                }
            }
        };

        // Wrap console methods to capture logs
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;

        console.log = (...args) => originalLog('[LIVE LOG]', ...args);
        console.error = (...args) => originalError('[LIVE ERR]', ...args);
        console.warn = (...args) => originalWarn('[LIVE WARN]', ...args);

        console.log('Initializing OddsApiLiveService...');
        oddsApiLiveService.init(mockIo);

        // Keep it running for 25 seconds, then clean up
        setTimeout(async () => {
            console.log('Stopping OddsApiLiveService...');
            oddsApiLiveService.destroy();
            await mongoose.disconnect();
            originalLog('Test completed.');
            process.exit(0);
        }, 25000);

    } catch (err) {
        console.error('Fatal error in test:', err);
        process.exit(1);
    }
}

runTest();
