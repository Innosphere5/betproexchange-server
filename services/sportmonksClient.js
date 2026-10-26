const axios = require('axios');
require('dotenv').config();

/**
 * Sportmonks Cricket API v2.0 Client
 * 
 * Enterprise-grade resilient HTTP client:
 * - Secure API token management (from env only)
 * - Trial-plan rate limiting (180 req/min cap aware)
 * - In-flight request deduplication (coalescing)
 * - Micro-caching (2s for live scores)
 * - Circuit breaker with auto-recovery
 * - Automatic redaction of sensitive credentials from logs
 */

const BASE_URL = 'https://cricket.sportmonks.com/api/v2.0';

class SportmonksClient {
  constructor() {
    this.apiToken = process.env.SPORTMONKS_API_KEY || process.env.API_KEY || '';
    if (!this.apiToken) {
      console.warn('[SportmonksClient] ⚠️ Warning: SPORTMONKS_API_KEY is not set in environment.');
    }

    // Rate Limiting (Sportmonks trial plan: 180 req / min)
    this.rateLimit = {
      limit: 180,
      remaining: 180,
      resetAt: Date.now() + 60000,
      minIntervalMs: 400, // Enforce min 400ms between calls (safe for 180 req/min plan)
      lastCallTime: 0
    };

    // Circuit Breaker
    this.breaker = {
      state: 'CLOSED', // 'CLOSED', 'OPEN', 'HALF_OPEN'
      failures: 0,
      threshold: 5,
      resetTimeoutMs: 30000,
      openedAt: null
    };

    // Micro-cache (1s for live scores so UI is always real-time)
    this.cache = new Map();
    this.cacheTTL = {
      livescores: 1000,   // 1s micro-cache for live score calls
      fixtures: 60000     // 1 min for static fixtures
    };

    // In-flight request deduplication map
    this.inflight = new Map();

    // Axios client instance with sensible defaults
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 12000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'BetPro-Exchange/2.0'
      }
    });
  }

  /**
   * Safe URL logger that redacts the API key
   */
  sanitizeUrl(url, params = {}) {
    const copy = { ...params };
    if (copy.api_token) copy.api_token = '***REDACTED***';
    const qs = new URLSearchParams(copy).toString();
    return `${url}${qs ? '?' + qs : ''}`;
  }

  /**
   * Check and enforce rate limits
   */
  async throttle() {
    const now = Date.now();

    // If remaining is dangerously low (< 5), wait until window resets
    if (this.rateLimit.remaining < 5 && now < this.rateLimit.resetAt) {
      const waitTime = Math.max(100, this.rateLimit.resetAt - now);
      console.warn(`[SportmonksClient] ⏳ Approaching rate limit (${this.rateLimit.remaining} remaining). Pausing ${waitTime}ms...`);
      await new Promise(r => setTimeout(r, waitTime));
    }

    // Enforce min interval
    const elapsed = now - this.rateLimit.lastCallTime;
    if (elapsed < this.rateLimit.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.rateLimit.minIntervalMs - elapsed));
    }

    this.rateLimit.lastCallTime = Date.now();
  }

  /**
   * Update rate limit state from Sportmonks response headers
   */
  updateRateLimits(headers = {}) {
    if (headers['x-ratelimit-limit']) {
      this.rateLimit.limit = parseInt(headers['x-ratelimit-limit'], 10);
    }
    if (headers['x-ratelimit-remaining']) {
      this.rateLimit.remaining = parseInt(headers['x-ratelimit-remaining'], 10);
    }
  }

  /**
   * Circuit breaker state check
   */
  canExecute() {
    if (this.breaker.state === 'CLOSED') return true;
    if (this.breaker.state === 'OPEN') {
      const elapsed = Date.now() - this.breaker.openedAt;
      if (elapsed >= this.breaker.resetTimeoutMs) {
        this.breaker.state = 'HALF_OPEN';
        console.log('[SportmonksClient] 🔄 Circuit breaker transitioned to HALF_OPEN');
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN allows trial call
  }

  recordSuccess() {
    this.breaker.failures = 0;
    this.breaker.state = 'CLOSED';
  }

  recordFailure(status, errorMsg) {
    if (status === 429) {
      this.rateLimit.remaining = 0;
      this.rateLimit.resetAt = Date.now() + 60000;
      console.warn('[SportmonksClient] ⚠️ 429 Too Many Requests received. Backing off for 60s.');
      return;
    }

    this.breaker.failures++;
    if (this.breaker.failures >= this.breaker.threshold) {
      this.breaker.state = 'OPEN';
      this.breaker.openedAt = Date.now();
      console.error(`[SportmonksClient] 🚨 Circuit breaker OPENED due to ${this.breaker.failures} consecutive failures.`);
    }
  }

  /**
   * Core request dispatcher with deduplication and caching
   */
  async request(endpoint, params = {}, ttlMs = 0) {
    const token = this.apiToken || process.env.SPORTMONKS_API_KEY || process.env.API_KEY;
    if (!token) {
      throw new Error('Sportmonks API token is missing');
    }

    const cacheKey = `${endpoint}_${JSON.stringify(params)}`;

    // 1. Check cache
    if (ttlMs > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < ttlMs) {
        return cached.data;
      }
    }

    // 2. Check in-flight requests (request coalescing)
    if (this.inflight.has(cacheKey)) {
      return this.inflight.get(cacheKey);
    }

    // 3. Check circuit breaker
    if (!this.canExecute()) {
      const cachedFallback = this.cache.get(cacheKey);
      if (cachedFallback) {
        console.warn(`[SportmonksClient] Circuit breaker is OPEN. Serving stale cached data for ${endpoint}.`);
        return cachedFallback.data;
      }
      throw new Error(`Sportmonks API unavailable (Circuit Breaker OPEN)`);
    }

    const promise = (async () => {
      await this.throttle();

      try {
        const response = await this.http.get(endpoint, {
          params: {
            api_token: token,
            ...params
          }
        });

        this.updateRateLimits(response.headers);
        this.recordSuccess();

        const result = response.data?.data ?? response.data;

        // Save to cache
        if (ttlMs > 0) {
          this.cache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
          });
        }

        return result;
      } catch (err) {
        const status = err.response?.status;
        const errMsg = err.response?.data?.message || err.message;
        this.recordFailure(status, errMsg);

        // Fallback to stale cache if available
        const stale = this.cache.get(cacheKey);
        if (stale) {
          console.warn(`[SportmonksClient] Error fetching ${endpoint}: ${errMsg}. Using stale cache.`);
          return stale.data;
        }

        throw new Error(`Sportmonks API request failed (${status || 'Network'}): ${typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)}`);
      } finally {
        this.inflight.delete(cacheKey);
      }
    })();

    this.inflight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Fetch Live Scores with full cricket details
   */
  async getLiveScores(customIncludes = null) {
    const include = customIncludes || 'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league';
    return this.request('livescores', { include }, this.cacheTTL.livescores);
  }

  /**
   * Fetch a specific fixture by ID with includes
   */
  async getFixtureById(fixtureId, customIncludes = null) {
    const include = customIncludes || 'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league';
    return this.request(`fixtures/${fixtureId}`, { include }, 2000);
  }

  /**
   * Fetch upcoming fixtures
   */
  async getUpcomingFixtures(page = 1) {
    return this.request('fixtures', {
      include: 'runs,localteam,visitorteam,league',
      page
    }, this.cacheTTL.fixtures);
  }

  /**
   * Get current rate limit and health metrics
   */
  getStatus() {
    return {
      rateLimit: { ...this.rateLimit },
      breaker: { ...this.breaker },
      cacheEntries: this.cache.size,
      inflightRequests: this.inflight.size
    };
  }
}

module.exports = new SportmonksClient();
