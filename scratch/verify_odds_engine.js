const mongoose = require('mongoose');
const { initOddsEngine } = require('../services/oddsEngine');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

async function test() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected');

        const mockIo = {
            emit: (event, data) => {
                console.log(`[Mock Socket] EMIT ${event}:`, JSON.stringify(data, null, 2));
            }
        };

        console.log('Starting Odds Engine...');
        initOddsEngine(mockIo);

        // Wait for 10 seconds to see if anything happens
        setTimeout(() => {
            console.log('Verification finished. Check logs above.');
            process.exit(0);
        }, 15000);

    } catch (err) {
        console.error('❌ Test failed:', err.message);
        process.exit(1);
    }
}

test();
