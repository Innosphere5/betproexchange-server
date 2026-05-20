const mongoose = require('mongoose');
require('dotenv').config();
const MarketOdds = require('../models/MarketOdds');
const axios = require('axios');

async function test() {
    await mongoose.connect(process.env.MONGO_URI);
    const market = await MarketOdds.findOne({ matchId: 69657 });
    if (!market) {
        console.log("Market not found");
        process.exit(1);
    }
    
    console.log("Found Market:", market.oddsApiEventId);
    
    const API_KEY = process.env.ODDS_API_KEY?.trim();
    try {
        const res = await axios.get('https://api.odds-api.io/v3/odds', {
            params: { apiKey: API_KEY, eventId: market.oddsApiEventId, bookmakers: 'Betfair Exchange,Bet365,12bet,Orbit Exchange,SkyExchange' }
        });
        console.log("Success");
    } catch (err) {
        console.error('Error status:', err.response?.status);
        console.error('Error data:', err.response?.data);
    }
    process.exit(0);
}

test();
