const axios = require('axios');
const Match = require('../models/Match');
require('dotenv').config();

const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://api.odds-api.io/v3';

const updateLiveScores = async () => {
    try {
        const liveMatches = await Match.find({ status: 'live' });
        
        if (liveMatches.length === 0) {
            return;
        }

        console.log(`Updating scores for ${liveMatches.length} live matches...`);

        // We fetch /events because it contains the latest scores for all active matches
        const response = await axios.get(`${BASE_URL}/events`, {
            params: { apiKey: API_KEY, sport: 'cricket' }
        });

        const latestEvents = response.data || [];

        for (const match of liveMatches) {
            const freshData = latestEvents.find(e => e.id.toString() === match.matchId);
            
            if (freshData && freshData.scores) {
                await Match.updateOne(
                    { matchId: match.matchId },
                    { 
                        $set: { 
                            score: freshData.scores,
                            lastUpdated: new Date()
                        } 
                    }
                );
            }
        }
    } catch (error) {
        console.error('Error updating scores:', error.message);
    }
};

module.exports = { updateLiveScores };
