const axios = require('axios');
require('dotenv').config();

/**
 * ════════════════════════════════════════════════════════════════════════
 *  Sportmonks Multi-API-Key Pool Client
 *  BetPro Exchange — Zero-Crash Failover Engine
 * ════════════════════════════════════════════════════════════════════════
 *
 *  ALGORITHM OVERVIEW
 *  ──────────────────
 *  1. PRIORITY QUEUE  — keys are scored (0–100). Best score = first pick.
 *  2. ROUND-ROBIN     — among tied-score keys, rotate to spread load evenly.
 *  3. INSTANT FAILOVER— on 429 / 5xx, mark key as COOLING then try next key
 *                       IN THE SAME REQUEST without returning an error.
 *  4. COOLDOWN TIMER  — exhausted key cools for `resetAt` window (~60s).
 *                       Score drops to 0. Auto-recovers when window expires.
 *  5. CIRCUIT BREAKER — 5 non-429 errors → OPEN state, 30s auto-recovery.
 *  6. LAST RESORT     — if ALL keys are exhausted/broken, wait for the
 *                       earliest cooldown to expire (max 5s), then retry once.
 *  7. ZERO CRASH      — every error path returns stale data or throws a
 *                       descriptive error (never crashes Node process).
 *
 *  Keys loaded from env:
 *    SPORTMONKS_API_KEY     (slot 1)
 *    SPORTMONKS_API_KEY_2   (slot 2)
 *    SPORTMONKS_API_KEY_3   (slot 3)
 *    SPORTMONKS_API_KEY_4   (slot 4)
 *    SPORTMONKS_API_KEY_5   (slot 5)
 *
 *  Capacity: 4 keys × 180 req/min = 720 req/min total
 * ════════════════════════════════════════════════════════════════════════
 */

const BASE_URL      = 'https://cricket.sportmonks.com/api/v2.0';
const TRIAL_LIMIT   = 180;   // Sportmonks trial: 180 req/min per key
const LOW_REMAINING = 15;    // Rotate when remaining drops below this threshold
const CB_THRESHOLD  = 5;     // Circuit breaker opens after N consecutive non-429 errors
const CB_RESET_MS   = 30000; // Circuit breaker auto-recovers after 30 seconds
const COOLDOWN_MS   = 62000; // Rate-limit cooldown window (62s — slight buffer over 60s)
const MIN_CALL_GAP  = 350;   // Min ms between consecutive calls on same key (safe headroom)

// ── Key State ───────────────────────────────────────────────────────────────

class KeySlot {
  constructor(key, index) {
    this.key         = key;
    this.index       = index;
    this.label       = `Key-${index + 1}`;
    this.masked      = key.slice(0, 6) + '...' + key.slice(-4);  // safe for logs

    // Rate limit
    this.remaining   = TRIAL_LIMIT;
    this.rateLimit   = TRIAL_LIMIT;
    this.coolingUntil = 0;      // epoch ms — 0 means NOT cooling

    // Circuit breaker
    this.cbFailures  = 0;
    this.cbOpenedAt  = 0;       // epoch ms — 0 means CLOSED

    // Timing
    this.lastCallAt  = 0;       // epoch ms of last API call
    this.totalCalls  = 0;
    this.totalErrors = 0;
    this.totalRotations = 0;    // how many times we were skipped due to being unavailable
  }

  // ── State predicates ────────────────────────────────────────────────

  /** Is this key currently rate-limited? */
  isCooling() {
    if (this.coolingUntil === 0) return false;
    if (Date.now() >= this.coolingUntil) {
      // Cooldown expired — auto-recover
      this.coolingUntil = 0;
      this.remaining    = TRIAL_LIMIT;
      console.log(`[ApiPool] 🟢 ${this.label} cooldown expired — back in rotation`);
      return false;
    }
    return true;
  }

  /** Is this key's circuit breaker open? */
  isCircuitOpen() {
    if (this.cbOpenedAt === 0) return false;
    if (Date.now() - this.cbOpenedAt >= CB_RESET_MS) {
      // Circuit auto-recovers after CB_RESET_MS
      this.cbOpenedAt = 0;
      this.cbFailures = 0;
      console.log(`[ApiPool] 🔄 ${this.label} circuit breaker recovered`);
      return false;
    }
    return true;
  }

  /**
   * Health score 0–100.
   *   100 = fully healthy, full remaining budget
   *     0 = cooling or circuit open (should NOT be picked)
   * Score is proportional to remaining request budget.
   */
  healthScore() {
    if (this.isCooling() || this.isCircuitOpen()) return 0;
    return Math.round((this.remaining / TRIAL_LIMIT) * 100);
  }

  /** Is this key ready to accept a new call right now? */
  isAvailable() {
    return !this.isCooling() && !this.isCircuitOpen() && this.remaining >= LOW_REMAINING;
  }

  /** Milliseconds to wait before next call on this key (rate-interval guard) */
  callGapMs() {
    const elapsed = Date.now() - this.lastCallAt;
    return elapsed < MIN_CALL_GAP ? MIN_CALL_GAP - elapsed : 0;
  }

  /** Earliest time this key becomes available again (for "wait for shortest cooldown") */
  availableAt() {
    if (this.isCooling()) return this.coolingUntil;
    if (this.isCircuitOpen()) return this.cbOpenedAt + CB_RESET_MS;
    return Date.now();
  }

  // ── State mutators ──────────────────────────────────────────────────

  /** Update remaining from API response headers */
  updateFromHeaders(headers = {}) {
    const hRemaining = headers['x-ratelimit-remaining'];
    const hLimit     = headers['x-ratelimit-limit'];
    if (hRemaining !== undefined) this.remaining = parseInt(hRemaining, 10) || 0;
    else                          this.remaining = Math.max(0, this.remaining - 1);
    if (hLimit !== undefined)     this.rateLimit  = parseInt(hLimit, 10) || TRIAL_LIMIT;

    // Pre-emptive cooldown: if remaining is critically low, treat as exhausted now
    if (this.remaining < LOW_REMAINING && this.coolingUntil === 0) {
      this.coolingUntil = Date.now() + COOLDOWN_MS;
      console.warn(`[ApiPool] 🟡 ${this.label} nearing limit (${this.remaining} left). Pre-cooling for ${COOLDOWN_MS / 1000}s.`);
    }
  }

  recordSuccess() {
    this.cbFailures = 0;      // any success resets circuit breaker counter
    this.totalCalls++;
  }

  /**
   * Record a failure.
   * @param {number} status - HTTP status code
   */
  recordFailure(status) {
    this.totalErrors++;

    if (status === 429) {
      // Rate limited: put key in cooldown
      this.remaining    = 0;
      this.coolingUntil = Date.now() + COOLDOWN_MS;
      console.warn(`[ApiPool] 🔴 ${this.label} → 429. Cooling for ${COOLDOWN_MS / 1000}s. Auto-rotating to next key.`);
      return;
    }

    if (status >= 500) {
      // Server errors: increment circuit breaker
      this.cbFailures++;
      if (this.cbFailures >= CB_THRESHOLD) {
        this.cbOpenedAt = Date.now();
        console.error(`[ApiPool] 🚨 ${this.label} circuit OPEN after ${this.cbFailures} server errors. Auto-recovers in ${CB_RESET_MS / 1000}s.`);
      }
      return;
    }

    if (status === 401 || status === 403) {
      // Invalid/expired key — circuit open permanently until manual fix
      this.cbOpenedAt = Date.now() + (365 * 24 * 3600 * 1000); // effectively permanent
      console.error(`[ApiPool] ❌ ${this.label} → ${status} Unauthorized. Key may be invalid. Permanently removed from rotation.`);
      return;
    }

    // Other 4xx (bad endpoint, etc) — don't penalize the key
  }

  getMetrics() {
    const score = this.healthScore();
    return {
      label:        this.label,
      masked:       this.masked,
      status:       this.isCooling() ? 'COOLING' : this.isCircuitOpen() ? 'CB_OPEN' : score < 20 ? 'LOW' : 'HEALTHY',
      healthScore:  score,
      remaining:    this.remaining,
      coolingFor:   this.isCooling() ? Math.ceil((this.coolingUntil - Date.now()) / 1000) + 's' : null,
      cbOpenFor:    this.isCircuitOpen() ? Math.ceil((this.cbOpenedAt + CB_RESET_MS - Date.now()) / 1000) + 's' : null,
      totalCalls:   this.totalCalls,
      totalErrors:  this.totalErrors,
      rotations:    this.totalRotations
    };
  }
}

// ── Pool Client ─────────────────────────────────────────────────────────────

class SportmonksPoolClient {
  constructor() {
    this.slots = [];
    this.rrIndex = 0;  // round-robin pointer

    // Load all API keys from environment
    const envKeys = [
      'SPORTMONKS_API_KEY',
      'SPORTMONKS_API_KEY_2',
      'SPORTMONKS_API_KEY_3',
      'SPORTMONKS_API_KEY_4',
      'SPORTMONKS_API_KEY_5',
      'API_KEY',  // legacy alias
    ];

    const seen = new Set();
    for (const envVar of envKeys) {
      const k = (process.env[envVar] || '').trim();
      if (k && !seen.has(k)) {
        seen.add(k);
        this.slots.push(new KeySlot(k, this.slots.length));
      }
    }

    if (this.slots.length === 0) {
      console.error('[ApiPool] ❌ No Sportmonks API keys found in environment!');
    } else {
      const capacity = this.slots.length * TRIAL_LIMIT;
      console.log(`[ApiPool] ✅ ${this.slots.length} key(s) loaded. Combined capacity: ${capacity} req/min`);
      this.slots.forEach(s => console.log(`[ApiPool]   ${s.label}: ${s.masked}`));
    }

    // Shared HTTP client (connection pooling)
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 12000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'BetPro-Exchange/2.0' }
    });

    // In-flight deduplication — coalesces simultaneous identical requests into one HTTP call
    this.inflight = new Map();

    // Stale cache — last successful response per endpoint (for last-resort fallback)
    this.staleCache = new Map();

    // Health log — periodic status to console
    this._startHealthMonitor();
  }

  // ── Key Selection Algorithm ─────────────────────────────────────────

  /**
   * ALGORITHM: Pick the best available key.
   *
   * Step 1: Score every slot (0–100 health score).
   * Step 2: Filter to slots with score > 0 (available).
   * Step 3: Sort descending by health score.
   * Step 4: Among slots with the SAME top score, pick via round-robin
   *         to distribute load evenly (prevents hot-key problem).
   * Step 5: If NO slots available → return null (triggers "wait and retry").
   */
  _pickKey() {
    if (this.slots.length === 0) return null;

    // Score all slots
    const scored = this.slots
      .map(s => ({ slot: s, score: s.healthScore() }))
      .filter(x => x.score > 0)         // only available keys
      .sort((a, b) => b.score - a.score); // best score first

    if (scored.length === 0) return null;

    // Among equal top-score keys, use round-robin
    const topScore  = scored[0].score;
    const topGroup  = scored.filter(x => x.score === topScore);
    const picked    = topGroup[this.rrIndex % topGroup.length];
    this.rrIndex    = (this.rrIndex + 1) % Math.max(1, topGroup.length);

    return picked.slot;
  }

  // ── Core Request Engine ─────────────────────────────────────────────

  /**
   * PUBLIC — Make a request with automatic failover.
   *
   * FAILOVER FLOW:
   *   attempt 1: pick best key → call API
   *     ├─ success → return data ✅
   *     ├─ 429     → mark key COOLING, pick NEXT key, retry immediately
   *     ├─ 5xx     → mark key failure, pick NEXT key, retry immediately
   *     └─ 4xx     → rethrow (bad endpoint, not a key problem)
   *   attempt N (all keys tried):
   *     → wait for shortest cooldown (max 5s)
   *     → try one final time
   *     → if still fails: return stale cache OR throw descriptive error
   *
   * @param {string} endpoint  e.g. 'livescores', 'fixtures/123'
   * @param {Object} params    query params (api_token is added automatically)
   * @returns {any}            parsed response data
   */
  async request(endpoint, params = {}) {
    // In-flight deduplication — identical concurrent calls share one HTTP round-trip
    const dedupKey = `${endpoint}|${JSON.stringify(params)}`;
    if (this.inflight.has(dedupKey)) {
      return this.inflight.get(dedupKey);
    }

    const promise = this._doRequest(endpoint, params, dedupKey);
    this.inflight.set(dedupKey, promise);
    return promise.finally(() => this.inflight.delete(dedupKey));
  }

  async _doRequest(endpoint, params, dedupKey) {
    const maxAttempts = Math.max(this.slots.length, 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const slot = this._pickKey();

      if (!slot) {
        // ALL keys exhausted — wait for the soonest recovery
        const waitMs = this._shortestCooldownMs();
        const cappedWait = Math.min(waitMs, 5000); // max 5s before giving up
        if (cappedWait > 50) {
          console.warn(`[ApiPool] ⏳ All ${this.slots.length} keys unavailable. Waiting ${cappedWait}ms for soonest recovery...`);
          await new Promise(r => setTimeout(r, cappedWait));
        }

        // Final attempt after wait
        const recoveredSlot = this._pickKey();
        if (recoveredSlot) {
          return this._callWithSlot(recoveredSlot, endpoint, params, dedupKey);
        }

        // Truly all dead — serve stale cache if available
        return this._staleOrThrow(endpoint, params, 'All Sportmonks API keys exhausted or in circuit-break');
      }

      try {
        return await this._callWithSlot(slot, endpoint, params, dedupKey);
      } catch (err) {
        const status = err.response?.status;
        slot.recordFailure(status);

        if (status === 429 || (status >= 500 && status < 600)) {
          // Recoverable — log and try next key on the NEXT iteration
          console.warn(`[ApiPool] 🔄 Rotating from ${slot.label} (HTTP ${status || 'ERR'}) → trying next key (attempt ${attempt + 1}/${maxAttempts})`);
          slot.totalRotations++;
          continue; // <— KEY LINE: loop continues with next slot
        }

        if (status === 401 || status === 403) {
          // Auth failure — key invalid, disable it and try next
          console.error(`[ApiPool] ❌ ${slot.label} auth failure (${status}). Disabling and rotating.`);
          slot.totalRotations++;
          continue;
        }

        // Network / timeout errors (no status) — try next key
        if (!status) {
          console.warn(`[ApiPool] 🔄 ${slot.label} network error (${err.message}). Rotating...`);
          slot.totalRotations++;
          continue;
        }

        // Other 4xx (bad endpoint, validation) — not a key problem, rethrow immediately
        throw err;
      }
    }

    // All attempts failed — serve stale or throw
    return this._staleOrThrow(endpoint, params, `All ${maxAttempts} key(s) failed for endpoint: ${endpoint}`);
  }

  /**
   * Execute one HTTP call on a specific slot.
   * Handles rate-interval throttling and updates slot state from response.
   */
  async _callWithSlot(slot, endpoint, params, dedupKey) {
    // Respect minimum call gap on this key
    const gap = slot.callGapMs();
    if (gap > 0) await new Promise(r => setTimeout(r, gap));

    slot.lastCallAt = Date.now();

    const response = await this.http.get(endpoint, {
      params: { api_token: slot.key, ...params }
    });

    slot.updateFromHeaders(response.headers);
    slot.recordSuccess();

    const data = response.data?.data ?? response.data;

    // Update stale cache on every success
    const cacheKey = `${endpoint}|${JSON.stringify(params)}`;
    this.staleCache.set(cacheKey, { data, savedAt: Date.now() });

    return data;
  }

  /**
   * Return stale cached data if available, otherwise throw.
   * This is the LAST LINE of defense — never crashes the pipeline.
   */
  _staleOrThrow(endpoint, params, reason) {
    const cacheKey = `${endpoint}|${JSON.stringify(params)}`;
    const stale = this.staleCache.get(cacheKey);
    if (stale) {
      const ageS = Math.round((Date.now() - stale.savedAt) / 1000);
      console.warn(`[ApiPool] ⚠️ ${reason}. Serving stale data (${ageS}s old) — pipeline continues safely.`);
      return stale.data;
    }
    throw new Error(`[ApiPool] ${reason}. No stale cache available for ${endpoint}.`);
  }

  /**
   * Find the soonest any key will become available again (ms from now).
   */
  _shortestCooldownMs() {
    if (this.slots.length === 0) return 60000;
    const soonest = Math.min(...this.slots.map(s => s.availableAt()));
    return Math.max(0, soonest - Date.now());
  }

  // ── Sportmonks-specific helpers ────────────────────────────────────

  async getLiveScores(customIncludes = null) {
    const include = customIncludes ||
      'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league';
    return this.request('livescores', { include });
  }

  /**
   * Fetch all fixtures currently in-play (alternative livescores endpoint).
   * On some Sportmonks trial plans, /livescores omits women's leagues.
   * /livescores/inplay may return more fixtures.
   */
  async getInplayFixtures(customIncludes = null) {
    const include = customIncludes ||
      'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league';
    try {
      return await this.request('livescores/inplay', { include });
    } catch (e) {
      // Some plans don't have /inplay — fall back gracefully
      return [];
    }
  }

  /**
   * Fetch fixtures for a specific date (YYYY-MM-DD) — useful for finding today's WBBL matches.
   * Sportmonks v2: GET /fixtures?filter[starts_between]=DATE,DATE&include=...
   */
  async getFixturesByDate(dateStr, customIncludes = null) {
    const include = customIncludes ||
      'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league';
    return this.request('fixtures', {
      include,
      'filter[starts_between]': `${dateStr},${dateStr}`
    });
  }

  /**
   * Search fixtures by team name using Sportmonks search endpoint.
   * GET /teams/search/{query} → find team IDs, then /fixtures?filter[team_id]=ID
   */
  async searchFixturesByTeamName(teamName) {
    try {
      const teams = await this.request(`teams/search/${encodeURIComponent(teamName)}`, {});
      if (!Array.isArray(teams) || teams.length === 0) return [];
      const teamId = teams[0].id;
      return this.request('fixtures', {
        'filter[team_id]': teamId,
        include: 'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league',
        'filter[status]': 'Live'
      });
    } catch (e) {
      return [];
    }
  }

  async getFixtureById(fixtureId, customIncludes = null) {
    const include = customIncludes ||
      'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league';
    return this.request(`fixtures/${fixtureId}`, { include });
  }

  async getUpcomingFixtures(page = 1) {
    return this.request('fixtures', {
      include: 'runs,localteam,visitorteam,league',
      page
    });
  }

  // ── Monitoring ──────────────────────────────────────────────────────

  /** Pool health snapshot — used by /api/pool-status endpoint */
  getStatus() {
    const available = this.slots.filter(s => s.isAvailable()).length;
    const totalCapacity = available * TRIAL_LIMIT;
    return {
      totalKeys:      this.slots.length,
      availableKeys:  available,
      unavailableKeys: this.slots.length - available,
      combinedCapacity: `${totalCapacity} req/min`,
      inflight:       this.inflight.size,
      staleCacheSize: this.staleCache.size,
      slots:          this.slots.map(s => s.getMetrics())
    };
  }

  /** Log key health every 5 minutes */
  _startHealthMonitor() {
    setInterval(() => {
      const s = this.getStatus();
      console.log(`[ApiPool] 📊 Health: ${s.availableKeys}/${s.totalKeys} keys available | capacity: ${s.combinedCapacity}`);
      s.slots.forEach(sl => {
        const cool = sl.coolingFor ? ` (cooling ${sl.coolingFor})` : '';
        const cb   = sl.cbOpenFor  ? ` (CB open ${sl.cbOpenFor})` : '';
        console.log(`[ApiPool]   ${sl.label} [${sl.masked}] score=${sl.healthScore} status=${sl.status}${cool}${cb} calls=${sl.totalCalls} errors=${sl.totalErrors}`);
      });
    }, 5 * 60 * 1000); // every 5 minutes
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────
module.exports = new SportmonksPoolClient();
