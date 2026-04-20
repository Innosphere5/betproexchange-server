const axios = require('axios');
require('dotenv').config();

const API_KEY  = process.env.API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

// ─── Cache ────────────────────────────────────────────────────────────────────
const cache = new Map();

const CACHE_TTL_MS = {
  events:  120 * 1000,      // 2 minutes — match list / upcoming
  scores:  20 * 1000,       // 20 seconds — live scores (reduced to 20s for real-time feel)
};

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
const breaker = {
  failures:    0,
  state:       'CLOSED',
  openedAt:    null,
  THRESHOLD:   5,
  RESET_MS:    5 * 60_000,
};

let rateLimitedUntil = null;
const inflight = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCacheValid(key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return false;
  return (Date.now() - entry.fetchedAt) < ttlMs;
}

function getCached(key) {
  return cache.get(key)?.data ?? null;
}

function setCache(key, data) {
  cache.set(key, { data, fetchedAt: Date.now() });
}

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

function recordFailure(status) {
  if (status === 429) {
    rateLimitedUntil = new Date(Date.now() + 5 * 60_000);
    console.warn(`[API Manager] ⚠️ 429 Rate Limit. Paused until ${rateLimitedUntil.toISOString()}`);
    return;
  }
  breaker.failures++;
  if (breaker.failures >= breaker.THRESHOLD) {
    breaker.state = 'OPEN';
    breaker.openedAt = Date.now();
  }
}

// ─── Core Fetch ──────────────────────────────────────────────────────────────

async function fetchWithRetry(path, params = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(`${BASE_URL}${path}`, {
        params: { apiKey: API_KEY, ...params },
        timeout: 15_000,
      });
      recordSuccess();
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        recordFailure(429);
        throw err;
      }
      if (status >= 400 && status < 500) {
        recordFailure(status);
        throw err;
      }
      if (attempt < retries) {
        await sleep(2000 * Math.pow(2, attempt - 1));
      } else {
        recordFailure(status);
        throw err;
      }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * getEvents
 * Now v4 compatible. 
 * @param {string} sport - e.g. 'cricket_ipl'
 * @param {'events'|'scores'} type - endpoint type
 */
async function getEvents(sport = 'cricket_ipl', type = 'events') {
  const endpoint = type === 'events' ? `/sports/${sport}/odds` : `/sports/${sport}/scores`;
  const cacheKey = `${type}:${sport}`;
  const ttl = CACHE_TTL_MS[type];

  if (isCacheValid(cacheKey, ttl)) return getCached(cacheKey);

  if (rateLimitedUntil && Date.now() < rateLimitedUntil) {
    return getCached(cacheKey) ?? [];
  }

  if (!checkCircuitBreaker()) return getCached(cacheKey) ?? [];

  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const params = type === 'events' ? { regions: 'uk', markets: 'h2h', oddsFormat: 'decimal' } : {};

  const promise = fetchWithRetry(endpoint, params)
    .then(data => {
      setCache(cacheKey, data);
      inflight.delete(cacheKey);
      return data;
    })
    .catch(err => {
      inflight.delete(cacheKey);
      return getCached(cacheKey) ?? [];
    });

  inflight.set(cacheKey, promise);
  return promise;
}

function getStatus() {
  return {
    rateLimitedUntil,
    circuitBreaker: breaker.state,
    cacheCount: cache.size
  };
}

function clearCache() {
  cache.clear();
}

module.exports = { getEvents, getStatus, clearCache };

