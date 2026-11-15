const poolClient = require('./sportmonksPoolClient');
require('dotenv').config();

/**
 * Sportmonks Cricket API v2.0 Client
 *
 * Now delegates all HTTP requests to SportmonksPoolClient which manages
 * multiple API keys with round-robin rotation and instant failover.
 * This module is kept as a stable interface for backward compatibility.
 *
 * Key improvements:
 * - Multiple trial accounts → N × 180 req/min capacity
 * - Zero 60s wait on 429: instantly rotates to next key
 * - Per-key circuit breakers with auto-recovery
 * - In-memory micro-cache for identical requests within same poll cycle
 */

const { Redis: _R } = (() => { try { return require('@upstash/redis'); } catch { return { Redis: null }; } })();

class SportmonksClient {
  constructor() {
    // Micro-cache (500ms) for identical requests in the same poll cycle
    this.cache = new Map();
    this.cacheTTL = {
      livescores: 500,    // 500ms — just enough to deduplicate burst calls
      fixtures: 60000     // 1 min for static fixtures
    };
    // Legacy compatibility field
    this.rateLimit = { limit: 180, remaining: 180, resetAt: Date.now() + 60000 };
    this.breaker = { state: 'CLOSED' };
  }

  /**
   * Core request — now routed through pool client for multi-key rotation.
   */
  async request(endpoint, params = {}, ttlMs = 0) {
    const cacheKey = `${endpoint}_${JSON.stringify(params)}`;

    if (ttlMs > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < ttlMs) {
        return cached.data;
      }
    }

    const result = await poolClient.request(endpoint, params);

    if (ttlMs > 0) {
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
    }

    return result;
  }

  /**
   * Fetch Live Scores with full cricket details
   */
  async getLiveScores(customIncludes = null) {
    const include = customIncludes || 'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league';
    return this.request('livescores', { include }, this.cacheTTL.livescores);
  }

  /**
   * Fetch a specific fixture by ID with includes — always fresh, no cache
   */
  async getFixtureById(fixtureId, customIncludes = null) {
    const include = customIncludes || 'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league';
    return this.request(`fixtures/${fixtureId}`, { include }, 0);
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
   * Get pool status (key health, rate limits, circuit breakers)
   */
  getStatus() {
    return poolClient.getStatus();
  }
}

module.exports = new SportmonksClient();
