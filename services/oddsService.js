const axios = require('axios');
const Match = require('../models/Match');
const Odds = require('../models/Odds');
require('dotenv').config();

const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.odds-api.io/v3';

// ─── Cache ────────────────────────────────────────────────────────────────────
let lastOddsMap = new Map(); // matchId -> processedOdds
let lastFetchedAt = 0;
const CACHE_TTL_MS = 30000;

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
const breaker = {
  failures: 0,
  state: 'CLOSED',
  openedAt: null,
  THRESHOLD: 3,
  RESET_MS: 120000,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const normalize = (name) => name ? name.toLowerCase().trim() : '';

function checkCircuitBreaker() {
  if (breaker.state === 'CLOSED') return true;
  if (breaker.state === 'OPEN') {
    const elapsed = Date.now() - breaker.openedAt;
    if (elapsed >= breaker.RESET_MS) {
      breaker.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }
  return true;
}

function recordSuccess() {
  breaker.failures = 0;
  breaker.state = 'CLOSED';
}

function recordFailure(err) {
  breaker.failures++;
  console.error(`[Odds Engine] ❌ API Failure (${breaker.failures}/${breaker.THRESHOLD}): ${err.message}`);
  if (breaker.failures >= breaker.THRESHOLD) {
    breaker.state = 'OPEN';
    breaker.openedAt = Date.now();
    console.error(`[Odds Engine] 🚨 Circuit Breaker OPEN for 2 minutes.`);
  }
}

// ─── Core Logic ──────────────────────────────────────────────────────────────

async function fetchOddsV3(eventIds) {
  if (!eventIds || eventIds.length === 0) return {};
  
  try {
    const response = await axios.get(`${BASE_URL}/odds/multi`, {
      params: {
        apiKey: API_KEY,
        eventIds: eventIds.join(','),
        bookmakers: 'Bet365,SingBet', // Using bookmakers allowed on user's plan
      },
      timeout: 10000
    });

    recordSuccess();
    return response.data; // This is an object where keys are event IDs
  } catch (err) {
    recordFailure(err);
    return null;
  }
}

async function updateOdds(io) {
  if (!checkCircuitBreaker()) {
    console.warn('[Odds Engine] Circuit breaker is OPEN. Skipping update.');
    return;
  }

  try {
    // 1. Get matches from DB that need odds (live or upcoming today)
    const today = new Date();
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // Prioritize Live, then Upcoming
    const dbMatches = await Match.find({ 
      status: { $in: ['live', 'upcoming'] },
      startTime: { $lte: endOfDay }
    }).sort({ status: -1, startTime: 1 }).limit(10); // Limit to 10 for free plan efficiency

    if (dbMatches.length === 0) {
      console.log('[Odds Engine] No matches requiring odds today.');
      return;
    }

    const eventIds = [];
    const matchMap = new Map(); // normalizedTeams -> dbMatch

    // 2. Fetch events from API to get their IDs
    // We fetch without filters first to ensure 200 OK, then map in memory
    const eventsResponse = await axios.get(`${BASE_URL}/events`, {
      params: { apiKey: API_KEY, sport: 'cricket', status: 'pending,live' },
      timeout: 10000
    });

    const apiEvents = eventsResponse.data;
    if (!apiEvents || !Array.isArray(apiEvents)) return;

    // Map DB matches to API events
    for (const dbMatch of dbMatches) {
      if (!dbMatch || !dbMatch.teamA) continue; // Defensive check for dbMatch

      const apiMatch = apiEvents.find(event => {
        if (!event || !event.home || !event.away) return false;
        const homeMatch = normalize(dbMatch.teamA) === normalize(event.home) && normalize(dbMatch.teamB) === normalize(event.away);
        const awayMatch = normalize(dbMatch.teamA) === normalize(event.away) && normalize(dbMatch.teamB) === normalize(event.home);
        return homeMatch || awayMatch;
      });
      if (apiMatch) {
        eventIds.push(apiMatch.id);
        matchMap.set(apiMatch.id, dbMatch);
      }
    }

    if (eventIds.length === 0) {
      console.log('[Odds Engine] No matching API events found for DB matches.');
      return;
    }

    // 3. Fetch odds in ONE call (max 10 IDs)
    const oddsByEvent = await fetchOddsV3(eventIds.slice(0, 10));
    if (!oddsByEvent) return;

    // 4. Process and Emit
    for (const eventIdStr of Object.keys(oddsByEvent)) {
      const eventId = Number(eventIdStr);
      const dbMatch = matchMap.get(eventId);
      const eventOdds = oddsByEvent[eventIdStr];

      if (!dbMatch || !dbMatch.teamA) continue; // Safety check

      const bookmakers = eventOdds.bookmakers || {};
      const firstBM = bookmakers['Bet365'] || bookmakers['SingBet'] || bookmakers[Object.keys(bookmakers)[0]];
      
      if (firstBM) {
        const mlMarket = firstBM.find(m => m.name === 'ML' || m.name === 'Match Winner');
        if (mlMarket && mlMarket.odds && mlMarket.odds[0]) {
          const oddsData = mlMarket.odds[0];
          const apiEvent = apiEvents.find(e => e.id === eventId);
          
          if (!apiEvent || !apiEvent.home) continue; // Safety check

          const isHomeA = normalize(dbMatch.teamA) === normalize(apiEvent.home);
          
          const backOddsA = Number(isHomeA ? oddsData.home : oddsData.away);
          const backOddsB = Number(isHomeA ? oddsData.away : oddsData.home);

          if (!isNaN(backOddsA) && !isNaN(backOddsB)) {
            const layOddsA = Number((backOddsA + 0.02).toFixed(2));
            const layOddsB = Number((backOddsB + 0.02).toFixed(2));

            // Update both Odds collection and Match document
            await Odds.findOneAndUpdate(
              { matchId: dbMatch.matchId },
              { matchId: dbMatch.matchId, teamA: dbMatch.teamA, teamB: dbMatch.teamB, backOddsA, layOddsA, backOddsB, layOddsB, updatedAt: new Date() },
              { upsert: true }
            );

            await Match.findOneAndUpdate(
              { matchId: dbMatch.matchId },
              { backOddsA, layOddsA, backOddsB, layOddsB, lastUpdated: new Date() }
            );

            if (io) {
              io.emit('odds_updated', { matchId: dbMatch.matchId, backOddsA, layOddsA, backOddsB, layOddsB });
            }
          }
        }
      }
    }
    
    // 5. Cleanup: Clear odds for matches that are no longer live/upcoming
    const inactiveMatches = await Match.find({ status: 'completed' });
    for (const m of inactiveMatches) {
        await Match.findOneAndUpdate({ matchId: m.matchId }, { backOddsA: null, layOddsA: null, backOddsB: null, layOddsB: null });
        await Odds.deleteMany({ matchId: m.matchId });
    }

    const remaining = eventsResponse.headers['x-ratelimit-remaining'];
    console.log(`[Odds Engine] Cycle complete. API Requests remaining this hour: ${remaining || 'N/A'}`);

  } catch (err) {
    console.error('[Odds Engine] Update cycle failed:', err.message);
    if (err.response && err.response.status === 429) {
        console.error('[Odds Engine] 🚨 RATE LIMIT EXCEEDED. The 100/hr limit is reached. Pausing for 5 minutes.');
        breaker.state = 'OPEN';
        breaker.openedAt = Date.now() + 180000; // Extra 3 mins
    }
  }
}




module.exports = { updateOdds };
