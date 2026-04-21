const axios = require('axios');
require('dotenv').config();

const API_TOKEN = process.env.API_KEY;
const BASE_URL  = 'https://cricket.sportmonks.com/api/v2.0';

// ─── Cache ────────────────────────────────────────────────────────────────────
const cache = new Map();

const CACHE_TTL_MS = {
  fixtures:  120 * 1000,      // 2 minutes — fixture list
  livescores: 20 * 1000,      // 20 seconds — live scores
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

function recordFailure(status, responseData) {
  if (status === 429) {
    rateLimitedUntil = new Date(Date.now() + 5 * 60_000);
    console.warn(`[API Manager] ⚠️ 429 Rate Limit. Paused until ${rateLimitedUntil.toISOString()}`);
    return;
  }
  
  if (responseData) {
    console.error(`[API Manager] Full Error Response:`, JSON.stringify(responseData, null, 2));
  }

  breaker.failures++;
  if (breaker.failures >= breaker.THRESHOLD) {
    breaker.state = 'OPEN';
    breaker.openedAt = Date.now();
  }
}

// ─── Core Fetch ──────────────────────────────────────────────────────────────

async function fetchFromSportmonks(endpoint, params = {}, retries = 2) {
  const url = `${BASE_URL}/${endpoint}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        params: { api_token: API_TOKEN, ...params },
        timeout: 15_000,
      });

      recordSuccess();
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const data   = err.response?.data;

      if (status === 429) {
        recordFailure(429, data);
        throw err;
      }
      
      if (status >= 400 && status < 500) {
        recordFailure(status, data);
        throw err;
      }

      if (attempt < retries) {
        await sleep(2000 * Math.pow(2, attempt - 1));
      } else {
        recordFailure(status, data);
        throw err;
      }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * getData
 * Sportmonks v2 compatible.
 * @param {string} endpoint - e.g. 'fixtures' or 'livescores/now'
 * @param {object} options - { include, filter, cacheKeySuffix }
 */
async function getData(endpoint, options = {}) {
  const { include, filter = {}, cacheKeySuffix = '' } = options;
  const type = endpoint.includes('livescores') ? 'livescores' : 'fixtures';
  
  const cacheKey = `${endpoint}:${cacheKeySuffix}:${JSON.stringify(filter)}:${include}`;
  const ttl = CACHE_TTL_MS[type] || 60000;

  if (isCacheValid(cacheKey, ttl)) return getCached(cacheKey);

  if (rateLimitedUntil && Date.now() < rateLimitedUntil) {
    return getCached(cacheKey) ?? null;
  }

  if (!checkCircuitBreaker()) return getCached(cacheKey) ?? null;

  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const params = { ...filter };
  if (include) params.include = include;

  const promise = fetchFromSportmonks(endpoint, params)
    .then(data => {
      setCache(cacheKey, data);
      inflight.delete(cacheKey);
      return data;
    })
    .catch(err => {
      inflight.delete(cacheKey);
      console.warn(`[API Manager] Request failed for ${endpoint}: ${err.message}`);
      return getCached(cacheKey) ?? null;
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

module.exports = { getData, getStatus };

