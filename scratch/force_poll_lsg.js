const axios = require('axios');
const Match = require('../models/Match');
const MarketOdds = require('../models/MarketOdds');
const { initOddsEngine } = require('../services/oddsEngine'); // We don't need init, just the functions if exported
const mongoose = require('mongoose');
require('dotenv').config();

async function forcePoll() {
    await mongoose.connect(process.env.MONGO_URI);
    const API_KEY = process.env.ODDS_API_KEY?.trim();
    const BASE_URL = 'https://api.odds-api.io/v3';
    const ALLOWED_BOOKMAKERS = 'SingBet,Betfair Exchange,Bet365,1xbet,Stake';

    const matchId = '69644';
    const market = await MarketOdds.findOne({ matchId });
    if (!market || !market.oddsApiEventId) {
        console.log('No mapping found for 69644');
        process.exit(1);
    }

    console.log(`Forcing poll for 69644 (Event ${market.oddsApiEventId})...`);
    try {
        const response = await axios.get(`${BASE_URL}/odds`, {
            params: { 
                apiKey: API_KEY, 
                eventId: market.oddsApiEventId,
                bookmakers: ALLOWED_BOOKMAKERS
            }
        });
        
        console.log('API Response received. Bookmakers available:', Object.keys(response.data.bookmakers || {}));
        
        // I'll just use the logic from handleOddsUpdate here to see where it fails
        const eventData = response.data;
        const bookmakers = eventData.bookmakers;
        const preferred = ALLOWED_BOOKMAKERS.split(',');
        let selectedBM = null;
        let mlMarket = null;

        for (const bmName of preferred) {
            if (bookmakers[bmName]) {
                console.log(`Checking ${bmName}...`);
                const found = bookmakers[bmName].find(m => m.name === 'ML' || m.name === 'Match Winner');
                if (found && found.odds && found.odds[0]) {
                    selectedBM = bmName;
                    mlMarket = found;
                    console.log(`Found ML in ${bmName}`);
                    break;
                }
            }
        }
        
        if (!mlMarket) {
            console.log('No ML market found in ANY allowed bookmaker!');
        } else {
            console.log('Selected Odds:', mlMarket.odds[0]);
            const isLive = eventData.status === 'live';
            const teamA_odds = { back: Number(mlMarket.odds[0].home), lay: Number(mlMarket.odds[0].layHome || (Number(mlMarket.odds[0].home) + 0.01).toFixed(2)) };
            const teamB_odds = { back: Number(mlMarket.odds[0].away), lay: Number(mlMarket.odds[0].layAway || (Number(mlMarket.odds[0].away) + 0.01).toFixed(2)) };

            await MarketOdds.findOneAndUpdate({ matchId }, {
                teamA: teamA_odds,
                teamB: teamB_odds,
                marketStatus: 'OPEN',
                updatedAt: new Date()
            });

            await Match.findOneAndUpdate({ matchId }, {
                backOddsA: teamA_odds.back,
                layOddsA: teamA_odds.lay,
                backOddsB: teamB_odds.back,
                layOddsB: teamB_odds.lay,
                marketStatus: 'OPEN',
                lastUpdated: new Date()
            });
            console.log('Database updated successfully for 69644');
        }

    } catch (err) {
        console.error(err.message);
    }
    process.exit(0);
}

forcePoll();
