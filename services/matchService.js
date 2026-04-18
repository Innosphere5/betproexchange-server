const axios = require('axios');
const Match = require('../models/Match');
require('dotenv').config();

const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://api.odds-api.io/v3';

const fetchUpcomingMatches = async () => {
    try {
        console.log('Fetching matches from odds-api.io...');
        const response = await axios.get(`${BASE_URL}/events`, {
            params: { apiKey: API_KEY, sport: 'cricket' }
        });

        const events = response.data || [];
        const now = new Date();

        // 1. IPL, 2. PSL, 3. International (Men) - Limit to 5
        let iplMatches = events.filter(e => e.league?.name?.includes('IPL') || e.league?.name?.includes('Indian Premier League'));
        let pslMatches = events.filter(e => e.league?.name?.includes('PSL') || e.league?.name?.includes('Pakistan Super League'));
        let intMatches = events.filter(e => e.league?.name?.includes('International') && !e.league?.name?.includes('Women'));

        let combined = [...iplMatches, ...pslMatches, ...intMatches].slice(0, 5);

        // Fallback to any 5 matches if we don't have enough from the above
        if (combined.length < 5) {
            const others = events.filter(e => !combined.find(c => c.id === e.id)).slice(0, 5 - combined.length);
            combined = [...combined, ...others];
        }

        for (const event of combined) {
            const isLive = new Date(event.date) <= now;
            
            const matchData = {
                matchId: event.id.toString(),
                teamA: event.home,
                teamB: event.away,
                league: event.league?.name || 'Cricket',
                startTime: new Date(event.date),
                status: isLive ? 'live' : 'upcoming',
                score: event.scores || { home: "0/0", away: "0/0" }
            };

            await Match.findOneAndUpdate(
                { matchId: matchData.matchId },
                { $set: matchData },
                { upsert: true, new: true }
            );
        }

        console.log(`Successfully synced ${combined.length} matches.`);
    } catch (error) {
        console.error('Error fetching matches:', error.message);
    }
};

module.exports = { fetchUpcomingMatches };
