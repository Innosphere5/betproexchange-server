const { Redis } = require('@upstash/redis');
require('dotenv').config();

/**
 * Upstash Redis Cache Layer for BetPro Exchange
 *
 * Ultra-low-latency (~5ms) serverless Redis cache that:
 * - Persists across server restarts (unlike in-memory Map)
 * - Works from Vercel Edge/Serverless (HTTP-based, no TCP needed)
 * - Provides sub-second TTLs for live scores
 * - Falls back gracefully to in-memory when Upstash is not configured
 *
 * Keys:
 *   bpx:score:<matchId>     → parsed live score payload (TTL 500ms–2s)
 *   bpx:fixture:<fixtureId> → raw Sportmonks fixture (TTL 1s)
 *   bpx:pool:status         → API key pool health metrics (TTL 60s)
 */

class UpstashRedisCache {
  constructor() {
    this.redis = null;
    this.enabled = false;
    this.fallbackCache = new Map(); // In-memory fallback when Upstash is not configured

    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (url && token) {
      try {
        this.redis = new Redis({ url, token });
        this.enabled = true;
        console.log('[UpstashRedis] ✅ Connected to Upstash Redis');
      } catch (err) {
        console.warn('[UpstashRedis] ⚠️ Failed to connect:', err.message, '— falling back to in-memory');
      }
    } else {
      console.warn('[UpstashRedis] ⚠️ UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set. Using in-memory fallback.');
    }

    // Stats
    this.stats = { hits: 0, misses: 0, sets: 0, errors: 0 };
  }

  /**
   * Get a cached value
   * @param {string} key - Cache key
   * @returns {any|null} - Cached value or null
   */
  async get(key) {
    try {
      if (this.enabled) {
        const val = await this.redis.get(key);
        if (val !== null && val !== undefined) {
          this.stats.hits++;
          return typeof val === 'string' ? JSON.parse(val) : val;
        }
        this.stats.misses++;
        return null;
      }

      // In-memory fallback
      const entry = this.fallbackCache.get(key);
      if (entry && Date.now() < entry.expiresAt) {
        this.stats.hits++;
        return entry.data;
      }
      if (entry) this.fallbackCache.delete(key);
      this.stats.misses++;
      return null;
    } catch (err) {
      this.stats.errors++;
      // Silent fallback to in-memory on Upstash error
      const entry = this.fallbackCache.get(key);
      if (entry && Date.now() < entry.expiresAt) return entry.data;
      return null;
    }
  }

  /**
   * Set a cached value with TTL
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttlMs - Time-to-live in milliseconds
   */
  async set(key, value, ttlMs = 1000) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    this.stats.sets++;

    // Always update in-memory fallback
    this.fallbackCache.set(key, {
      data: value,
      expiresAt: Date.now() + ttlMs
    });

    if (this.enabled) {
      try {
        // Upstash px = millisecond TTL
        await this.redis.set(key, serialized, { px: ttlMs });
      } catch (err) {
        this.stats.errors++;
        // Silent — in-memory fallback is already set
      }
    }
  }

  /**
   * Delete a cached value
   */
  async del(key) {
    this.fallbackCache.delete(key);
    if (this.enabled) {
      try {
        await this.redis.del(key);
      } catch (err) {
        this.stats.errors++;
      }
    }
  }

  /**
   * Batch get multiple keys
   * @param {string[]} keys
   * @returns {Object} - { key: value } map
   */
  async mget(keys) {
    const results = {};
    if (!keys || keys.length === 0) return results;

    if (this.enabled) {
      try {
        const vals = await this.redis.mget(...keys);
        keys.forEach((k, i) => {
          if (vals[i] !== null && vals[i] !== undefined) {
            results[k] = typeof vals[i] === 'string' ? JSON.parse(vals[i]) : vals[i];
            this.stats.hits++;
          } else {
            this.stats.misses++;
          }
        });
        return results;
      } catch (err) {
        this.stats.errors++;
        // Fall through to in-memory
      }
    }

    // In-memory fallback
    for (const k of keys) {
      const entry = this.fallbackCache.get(k);
      if (entry && Date.now() < entry.expiresAt) {
        results[k] = entry.data;
        this.stats.hits++;
      } else {
        this.stats.misses++;
      }
    }
    return results;
  }

  // ─── Score-specific helpers ──────────────────────────

  /**
   * Cache a live score payload
   * @param {string} matchId
   * @param {Object} scoreData - Parsed score payload
   * @param {number} ttlMs - Default 2000ms for live, 30000ms for completed
   */
  async setScore(matchId, scoreData, ttlMs = 2000) {
    return this.set(`bpx:score:${matchId}`, scoreData, ttlMs);
  }

  /**
   * Get cached live score
   * @param {string} matchId
   * @returns {Object|null}
   */
  async getScore(matchId) {
    return this.get(`bpx:score:${matchId}`);
  }

  /**
   * Cache raw Sportmonks fixture response
   */
  async setFixture(fixtureId, fixtureData, ttlMs = 1000) {
    return this.set(`bpx:fixture:${fixtureId}`, fixtureData, ttlMs);
  }

  /**
   * Get cached raw fixture
   */
  async getFixture(fixtureId) {
    return this.get(`bpx:fixture:${fixtureId}`);
  }

  /**
   * Cache API pool health status
   */
  async setPoolStatus(statusData) {
    return this.set('bpx:pool:status', statusData, 60000);
  }

  /**
   * Get cache health stats
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate: total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) + '%' : '0%',
      upstashEnabled: this.enabled,
      fallbackEntries: this.fallbackCache.size
    };
  }

  /**
   * Periodic cleanup of expired in-memory entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.fallbackCache) {
      if (now >= entry.expiresAt) {
        this.fallbackCache.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }
}

// Singleton
const cache = new UpstashRedisCache();

// Cleanup expired in-memory entries every 30 seconds
setInterval(() => cache.cleanup(), 30000);

module.exports = cache;

