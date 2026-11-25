const { Redis: RestRedis } = require('@upstash/redis');
let IORedis = null;
try {
  IORedis = require('ioredis');
} catch (e) {
  // ioredis optional fallback
}
require('dotenv').config();

/**
 * Upstash Redis Dual-Mode Cache Layer for BetPro Exchange
 *
 * Supports:
 * 1. Low-latency TCP connection via ioredis (when REDIS_URL is provided)
 * 2. Serverless HTTP REST via @upstash/redis (when UPSTASH_REDIS_REST_URL is provided)
 * 3. Sub-millisecond L1 in-memory Map cache (0ms instant response)
 *
 * Keys:
 *   bpx:matches:live        → active live matches array (TTL 4s-10s)
 *   bpx:matches:all         → full cricket catalog (TTL 10s-30s)
 *   bpx:score:<matchId>     → parsed live score payload (TTL 500ms–2s)
 *   bpx:odds:<matchId>      → parsed real-time odds (TTL 2s–15s)
 *   bpx:user:<userId>:wallet→ user wallet balances
 */

class UpstashRedisCache {
  constructor() {
    this.tcpClient = null;
    this.restClient = null;
    this.tcpEnabled = false;
    this.restEnabled = false;
    this.fallbackCache = new Map(); // L1 In-Memory Cache (sub-millisecond)

    // Stats
    this.stats = { hits: 0, misses: 0, sets: 0, errors: 0 };

    // 1. Try TCP connection via ioredis if REDIS_URL is configured
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl && IORedis) {
      try {
        this.tcpClient = new IORedis(redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 2500,
          commandTimeout: 1500,
          enableReadyCheck: false,
          autoResubscribe: false,
          autoResendUnfulfilledCommands: false,
          retryStrategy: (times) => (times > 2 ? null : Math.min(times * 500, 2000)),
        });

        this.tcpClient.on('connect', () => {
          this.tcpEnabled = true;
          console.log('[UpstashRedis] ✅ Connected via TCP (ioredis)');
        });

        this.tcpClient.on('error', (err) => {
          this.stats.errors++;
          // Non-fatal warning — application continues via L1 memory & REST
          if (this.tcpEnabled) {
            console.warn('[UpstashRedis] ⚠️ TCP connection error:', err.message);
          }
          this.tcpEnabled = false;
        });

        this.tcpClient.on('close', () => {
          this.tcpEnabled = false;
        });

        // Trigger non-blocking connection
        this.tcpClient.connect().then(() => {
          this.tcpEnabled = true;
        }).catch((err) => {
          this.tcpEnabled = false;
          console.warn('[UpstashRedis] ℹ️ TCP initial connection notice:', err.message, '— active on L1 memory cache');
        });
      } catch (tcpErr) {
        console.warn('[UpstashRedis] ⚠️ Failed to initialize ioredis TCP:', tcpErr.message);
      }
    }

    // 2. Try Upstash REST client
    const restUrl = process.env.UPSTASH_REDIS_REST_URL;
    const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (restUrl && restToken) {
      try {
        this.restClient = new RestRedis({ url: restUrl, token: restToken });
        this.restEnabled = true;
        console.log('[UpstashRedis] ✅ Connected via Upstash REST');
      } catch (err) {
        console.warn('[UpstashRedis] ⚠️ REST init notice:', err.message);
      }
    }

    if (!this.tcpClient && !this.restClient) {
      console.log('[UpstashRedis] ⚡ Operating on high-speed In-Memory L1 Cache (<0.1ms latency)');
    }
  }

  /**
   * Get a cached value.
   * Priority: L1 in-memory cache (0.01ms) -> TCP Redis (<5ms) -> REST Redis (~20ms).
   * @param {string} key - Cache key
   * @returns {any|null} - Cached value or null
   */
  async get(key) {
    // ⚡ Tier 0: Instant L1 In-Memory Check (<0.1ms)
    const memEntry = this.fallbackCache.get(key);
    if (memEntry) {
      if (Date.now() < memEntry.expiresAt) {
        this.stats.hits++;
        return memEntry.data;
      }
      this.fallbackCache.delete(key);
    }

    // ⚡ Tier 1: TCP Redis (ioredis)
    if (this.tcpClient && this.tcpEnabled) {
      try {
        const valPromise = this.tcpClient.get(key);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 250));
        const val = await Promise.race([valPromise, timeoutPromise]);
        if (val !== null && val !== undefined) {
          this.stats.hits++;
          const parsed = typeof val === 'string' ? JSON.parse(val) : val;
          // Populate L1 cache for subsequent fast reads
          this.fallbackCache.set(key, { data: parsed, expiresAt: Date.now() + 2000 });
          return parsed;
        }
      } catch (err) {
        this.stats.errors++;
        // Continue to fallback
      }
    }

    // ⚡ Tier 2: Upstash REST Redis
    if (this.restClient && this.restEnabled) {
      try {
        const valPromise = this.restClient.get(key);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 350));
        const val = await Promise.race([valPromise, timeoutPromise]);
        if (val !== null && val !== undefined) {
          this.stats.hits++;
          const parsed = typeof val === 'string' ? JSON.parse(val) : val;
          this.fallbackCache.set(key, { data: parsed, expiresAt: Date.now() + 2000 });
          return parsed;
        }
      } catch (err) {
        this.stats.errors++;
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Set a cached value with TTL.
   * Writes to L1 memory cache instantly (0ms), then updates remote Redis in background.
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttlMs - Time-to-live in milliseconds
   */
  async set(key, value, ttlMs = 2000) {
    this.stats.sets++;

    // ⚡ 1. Always update L1 in-memory cache immediately (0ms)
    this.fallbackCache.set(key, {
      data: value,
      expiresAt: Date.now() + ttlMs
    });

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    // ⚡ 2. Asynchronously update TCP Redis in background (non-blocking)
    if (this.tcpClient && this.tcpEnabled) {
      this.tcpClient.set(key, serialized, 'PX', ttlMs).catch((e) => {
        this.stats.errors++;
      });
    }

    // ⚡ 3. Asynchronously update REST Redis in background (non-blocking)
    if (this.restClient && this.restEnabled && !this.tcpEnabled) {
      this.restClient.set(key, serialized, { px: ttlMs }).catch((e) => {
        this.stats.errors++;
      });
    }
  }

  /**
   * Delete a cached value
   */
  async del(key) {
    this.fallbackCache.delete(key);
    if (this.tcpClient && this.tcpEnabled) {
      this.tcpClient.del(key).catch(() => {});
    }
    if (this.restClient && this.restEnabled) {
      this.restClient.del(key).catch(() => {});
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

    const missingKeys = [];
    for (const k of keys) {
      const memEntry = this.fallbackCache.get(k);
      if (memEntry && Date.now() < memEntry.expiresAt) {
        results[k] = memEntry.data;
        this.stats.hits++;
      } else {
        missingKeys.push(k);
      }
    }

    if (missingKeys.length === 0) return results;

    if (this.tcpClient && this.tcpEnabled) {
      try {
        const vals = await this.tcpClient.mget(...missingKeys);
        missingKeys.forEach((k, i) => {
          if (vals[i] !== null && vals[i] !== undefined) {
            const parsed = typeof vals[i] === 'string' ? JSON.parse(vals[i]) : vals[i];
            results[k] = parsed;
            this.fallbackCache.set(k, { data: parsed, expiresAt: Date.now() + 2000 });
            this.stats.hits++;
          } else {
            this.stats.misses++;
          }
        });
        return results;
      } catch (err) {
        this.stats.errors++;
      }
    }

    return results;
  }

  // ─── Score-specific helpers ──────────────────────────

  async setScore(matchId, scoreData, ttlMs = 2000) {
    return this.set(`bpx:score:${matchId}`, scoreData, ttlMs);
  }

  async getScore(matchId) {
    return this.get(`bpx:score:${matchId}`);
  }

  // ─── Odds-specific helpers ──────────────────────────

  async setOdds(matchId, oddsData, ttlMs = 2000) {
    return this.set(`bpx:odds:${matchId}`, oddsData, ttlMs);
  }

  async getOdds(matchId) {
    return this.get(`bpx:odds:${matchId}`);
  }

  // ─── Match Catalog Caching (Instant dashboard listing) ─────────────

  async setLiveMatches(matches, ttlMs = 5000) {
    return this.set('bpx:matches:live', matches, ttlMs);
  }

  async getLiveMatches() {
    return this.get('bpx:matches:live');
  }

  async setAllMatches(matches, ttlMs = 15000) {
    return this.set('bpx:matches:all', matches, ttlMs);
  }

  async getAllMatches() {
    return this.get('bpx:matches:all');
  }

  async invalidateMatchCatalogs() {
    await Promise.all([
      this.del('bpx:matches:live'),
      this.del('bpx:matches:all')
    ]);
  }

  // ─── User Account & Wallet Fast Cache ────────────────────────────────

  async setUserWallet(userId, walletData, ttlMs = 15000) {
    return this.set(`bpx:user:${userId}:wallet`, walletData, ttlMs);
  }

  async getUserWallet(userId) {
    return this.get(`bpx:user:${userId}:wallet`);
  }

  async invalidateUserWallet(userId) {
    return this.del(`bpx:user:${userId}:wallet`);
  }

  async setUserLimits(userId, limitsData, ttlMs = 60000) {
    return this.set(`bpx:user:${userId}:limits`, limitsData, ttlMs);
  }

  async getUserLimits(userId) {
    return this.get(`bpx:user:${userId}:limits`);
  }

  async invalidateUserLimits(userId) {
    return this.del(`bpx:user:${userId}:limits`);
  }

  async setFixture(fixtureId, fixtureData, ttlMs = 1000) {
    return this.set(`bpx:fixture:${fixtureId}`, fixtureData, ttlMs);
  }

  async getFixture(fixtureId) {
    return this.get(`bpx:fixture:${fixtureId}`);
  }

  async setPoolStatus(statusData) {
    return this.set('bpx:pool:status', statusData, 60000);
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate: total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) + '%' : '0%',
      tcpEnabled: this.tcpEnabled,
      restEnabled: this.restEnabled,
      fallbackEntries: this.fallbackCache.size
    };
  }

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

// Periodic cleanup of expired in-memory entries every 30 seconds
setInterval(() => cache.cleanup(), 30000);

module.exports = cache;
