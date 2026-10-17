const axios = require('axios');
require('dotenv').config();

const BASE_URL = 'https://v5.oddspapi.io/en';

class OddsApiRest {
    constructor() {
        this.apiKey = process.env.ODDS_API_KEY || '47867a6c1b58b5b0c53fdf6fe4fed924';
        this.rateLimitRemaining = null;
        this.rateLimitReset = null;
        this.scoreCooldowns = new Map();
        this.scoreCache = new Map();
        this.getScores = this.getScores.bind(this);
        this.normalizeScoresBreakdown = this.normalizeScoresBreakdown.bind(this);
    }

    async request(endpoint, params = {}) {
        if (!this.apiKey) {
            throw new Error('[OddsAPI REST] Missing ODDS_API_KEY');
        }

        if (this.rateLimitRemaining !== null && this.rateLimitRemaining <= 0) {
            const now = Math.floor(Date.now() / 1000);
            if (this.rateLimitReset && now < this.rateLimitReset) {
                const waitSec = this.rateLimitReset - now;
                console.warn(`[OddsAPI REST] Rate limited. Waiting ${waitSec}s...`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
            }
        }

        const url = `${BASE_URL}/${endpoint}`;
        try {
            const response = await axios.get(url, {
                params: { apiKey: this.apiKey, ...params },
                timeout: 15000
            });

            const headers = response.headers;
            if (headers['x-ratelimit-remaining'] !== undefined) {
                this.rateLimitRemaining = parseInt(headers['x-ratelimit-remaining'], 10);
            }
            if (headers['x-ratelimit-reset'] !== undefined) {
                this.rateLimitReset = parseInt(headers['x-ratelimit-reset'], 10);
            }

            return response.data;
        } catch (err) {
            const status = err.response?.status;
            if (status === 429) {
                const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '5', 10);
                this.rateLimitRemaining = 0;
                this.rateLimitReset = Math.floor(Date.now() / 1000) + retryAfter;
                console.warn(`[OddsAPI REST] 429 Rate limited. Retry after ${retryAfter}s`);
            }
            throw err;
        }
    }

    async getSports() {
        return this.request('sports');
    }

    async getTournaments(sportId) {
        return this.request('tournaments', { sportId: sportId });
    }

    async getFixtures(params = {}) {
        return this.request('fixtures', { sportId: 27, ...params });
    }

    async getFixturesForDate(dateStr, params = {}) {
        const start = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
        const end = Math.floor(new Date(`${dateStr}T23:59:59Z`).getTime() / 1000);
        return this.request('fixtures', { sportId: 27, startTimeFrom: start, startTimeTo: end, ...params });
    }

    async getFixturesLive(params = {}) {
        return this.request('fixtures/live', { sportId: 27, ...params });
    }

    async getFixturesToday(params = {}) {
        return this.request('fixtures/today', { sportId: 27, ...params });
    }

    async getFixtureOdds(fixtureId, bookmakers = []) {
        const params = { fixtureId };
        if (bookmakers.length > 0) {
            params.bookmakers = bookmakers.join(',');
        }
        return this.request('fixtures/odds', params);
    }

    async getMarkets(params = {}) {
        return this.request('markets', params);
    }

    /**
     * GET /v4/scores (or v5 equivalent)
     * Retrieves the score breakdown by period for a specified event.
     * Enforces the 1000ms endpoint cooldown (rate limit).
     */
    async getScores(fixtureId) {
        if (!fixtureId) throw new Error('[OddsAPI REST] fixtureId is required');

        if (!this.scoreCooldowns) this.scoreCooldowns = new Map();
        if (!this.scoreCache) this.scoreCache = new Map();

        const now = Date.now();
        const lastCall = this.scoreCooldowns.get(fixtureId) || 0;
        const cached = this.scoreCache.get(fixtureId);

        // Cooldown: 1000ms per fixture
        if (now - lastCall < 1000 && cached) {
            return cached;
        }

        this.scoreCooldowns.set(fixtureId, now);

        try {
            // Attempt 1: Try dedicated scores endpoint
            let rawData;
            try {
                rawData = await this.request('scores', { fixtureId });
            } catch (err) {
                // If 404, fall back to retrieving fixture details which includes scores
                if (err.response?.status === 404) {
                    const fixtures = await this.request('fixtures', { sportId: 27, fixtureIds: fixtureId });
                    if (Array.isArray(fixtures) && fixtures.length > 0) {
                        rawData = {
                            fixtureId: fixtures[0].fixtureId || fixtureId,
                            scores: fixtures[0].scores || {}
                        };
                    }
                } else {
                    throw err;
                }
            }

            const normalizedScores = this.normalizeScoresBreakdown(rawData?.scores || {});
            const result = {
                fixtureId: rawData?.fixtureId || fixtureId,
                scores: normalizedScores
            };

            this.scoreCache.set(fixtureId, result);
            return result;
        } catch (err) {
            if (cached) {
                return cached;
            }
            throw err;
        }
    }

    /**
     * Normalizes scores into the official period format { "0": {...}, "1": {...}, ... }
     */
    normalizeScoresBreakdown(rawScores = {}) {
        const out = {};
        const nowIso = new Date().toISOString();

        // 1. Direct period numbers e.g. "0", "1", "2", "3"
        for (const [key, val] of Object.entries(rawScores)) {
            if (!isNaN(key)) {
                out[key] = {
                    participant1Score: Number(val?.participant1Score || 0),
                    participant2Score: Number(val?.participant2Score || 0),
                    updatedAt: val?.updatedAt || nowIso
                };
            }
        }

        // 2. Map named keys like "result", "p1", "p2", "p3" to period numbers
        if (rawScores.result && !out["0"]) {
            out["0"] = {
                participant1Score: Number(rawScores.result.participant1Score || 0),
                participant2Score: Number(rawScores.result.participant2Score || 0),
                updatedAt: rawScores.result.updatedAt || nowIso
            };
        }
        if (rawScores.p1 && !out["1"]) {
            out["1"] = {
                participant1Score: Number(rawScores.p1.participant1Score || 0),
                participant2Score: Number(rawScores.p1.participant2Score || 0),
                updatedAt: rawScores.p1.updatedAt || nowIso
            };
        }
        if (rawScores.p2 && !out["2"]) {
            out["2"] = {
                participant1Score: Number(rawScores.p2.participant1Score || 0),
                participant2Score: Number(rawScores.p2.participant2Score || 0),
                updatedAt: rawScores.p2.updatedAt || nowIso
            };
        }
        if (rawScores.p3 && !out["3"]) {
            out["3"] = {
                participant1Score: Number(rawScores.p3.participant1Score || 0),
                participant2Score: Number(rawScores.p3.participant2Score || 0),
                updatedAt: rawScores.p3.updatedAt || nowIso
            };
        }

        // 3. Fallback: If only result exists in "0", extract innings periods
        if (out["0"] && (!out["1"] && !out["2"])) {
            const p1Total = out["0"].participant1Score;
            const p2Total = out["0"].participant2Score;
            if (p1Total > 0 && p2Total > 0) {
                // If both scored, Innings 1 has the first team's score, Innings 2 has the second
                out["1"] = {
                    participant1Score: p1Total,
                    participant2Score: 0,
                    updatedAt: out["0"].updatedAt
                };
                out["2"] = {
                    participant1Score: 0,
                    participant2Score: p2Total,
                    updatedAt: out["0"].updatedAt
                };
            } else if (p1Total > 0) {
                out["1"] = {
                    participant1Score: p1Total,
                    participant2Score: 0,
                    updatedAt: out["0"].updatedAt
                };
            } else if (p2Total > 0) {
                out["1"] = {
                    participant1Score: 0,
                    participant2Score: p2Total,
                    updatedAt: out["0"].updatedAt
                };
            }
        }

        // Guarantee at least "0" exists
        if (!out["0"]) {
            out["0"] = {
                participant1Score: 0,
                participant2Score: 0,
                updatedAt: nowIso
            };
        }

        return out;
    }
}

module.exports = new OddsApiRest();
