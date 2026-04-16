const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const API_KEY = process.env.ODDS_API_KEY;

app.use(cors());
app.use(express.json());

// In-memory cache for simplicity (can be upgraded to Redis later)
let cache = {
  data: [],
  lastFetch: null,
};

const CACHE_TTL = 30 * 1000; // 30 seconds

/*
const fetchCricketMatches = async () => {
  const now = new Date();
  if (cache.lastFetch && now - cache.lastFetch < CACHE_TTL) {
    console.log('Returning cached content');
    return cache.data;
  }

  try {
    const sports = ['cricket_ipl', 'cricket_international_t20', 'cricket_odi'];
    const leaguesPromises = sports.map(sport =>
      axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
        params: {
          apiKey: API_KEY,
          regions: 'uk', // UK region often has good cricket coverage
          markets: 'h2h',
          oddsFormat: 'decimal'
        }
      })
    );

    const responses = await Promise.allSettled(leaguesPromises);
    let allMatches = [];

    responses.forEach((res, index) => {
      if (res.status === 'fulfilled') {
        const matches = res.value.data.map(match => ({
          id: match.id,
          sport: 'cricket',
          isHeader: false,
          label: `${match.home_team} v ${match.away_team}`,
          league: match.sport_title,
          commence_time: match.commence_time,
          volume: "1,245,678", // Mocked volume since API doesn't provide it
          hasTv: true,
          hasInfo: true,
          isMatched: true,
          odds: match.bookmakers?.[0]?.markets?.[0]?.outcomes || []
        }));
        allMatches = [...allMatches, ...matches];
      } else {
        console.error(`Error fetching sports[${index}]:`, res.reason.message);
      }
    });

    // Sort by commence time
    allMatches.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

    cache.data = allMatches;
    cache.lastFetch = now;
    return allMatches;
  } catch (error) {
    console.error('Master Cricket Fetch Error:', error.message);
    return cache.data; // Return stale data if available
  }
};
*/

const fetchCricketMatches = async () => {
  const now = new Date();
  if (cache.lastFetch && now - cache.lastFetch < CACHE_TTL) {
    console.log('Returning cached content');
    return cache.data;
  }

  try {
    console.log('Fetching events from odds-api.io...');
    // Step 1: Fetch Cricket events
    const eventsResponse = await axios.get('https://api.odds-api.io/v3/events', {
      params: {
        apiKey: API_KEY,
        sport: 'cricket'
      }
    });

    const events = eventsResponse.data;
    if (!events || events.length === 0) {
      console.log('No events found');
      return [];
    }

    // Step 2: Fetch odds in batch (Odds-API.io limits to 10 eventIds per request)
    const limitedEvents = events.slice(0, 10);
    const eventIds = limitedEvents.map(e => e.id).join(',');
    console.log(`Fetching odds for ${limitedEvents.length} events...`);
    
    const oddsResponse = await axios.get('https://api.odds-api.io/v3/odds/multi', {
      params: {
        apiKey: API_KEY,
        eventIds: eventIds,
        bookmakers: 'Bet365,SingBet' // Choose preferred bookmakers
      }
    });

    const multiOdds = oddsResponse.data;
    const oddsMap = new Map(multiOdds.map(o => [o.id, o]));

    // Step 3: Map to original structure
    const allMatches = limitedEvents.map(event => {
      const matchOdds = oddsMap.get(event.id);
      let outcomes = [];

      if (matchOdds && matchOdds.bookmakers) {
        // Use Bet365 if available, otherwise first available
        const bookmaker = matchOdds.bookmakers['Bet365'] || Object.values(matchOdds.bookmakers)[0];
        const mlMarket = bookmaker?.find(m => m.name === 'ML');
        const oddsValues = mlMarket?.odds[0];

        if (oddsValues) {
          if (oddsValues.home) outcomes.push({ name: event.home, price: parseFloat(oddsValues.home) });
          if (oddsValues.draw) outcomes.push({ name: 'Draw', price: parseFloat(oddsValues.draw) });
          if (oddsValues.away) outcomes.push({ name: event.away, price: parseFloat(oddsValues.away) });
        }
      }

      return {
        id: event.id.toString(),
        sport: 'cricket',
        isHeader: false,
        label: `${event.home} v ${event.away}`,
        league: event.league?.name || 'Cricket',
        commence_time: event.date,
        volume: "1,245,678",
        hasTv: true,
        hasInfo: true,
        isMatched: true,
        odds: outcomes
      };
    });

    // Sort by commence time
    allMatches.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

    cache.data = allMatches;
    cache.lastFetch = now;
    return allMatches;
  } catch (error) {
    console.error('Odds-API.io Fetch Error:', error.response?.data || error.message);
    return cache.data; // Return stale data if available
  }
};

app.get('/', (req, res) => {
  res.send('server work');
});
app.get('/api/cricket-matches', async (req, res) => {
  try {
    const matches = await fetchCricketMatches();
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
