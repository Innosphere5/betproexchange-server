const axios = require('axios');
require('dotenv').config();

const BASE_URL = 'https://api.odds-api.io/v3';

class OddsApiRest {
    constructor() {
        this.apiKey = process.env.ODDS_API_KEY;
        this.rateLimitRemaining = null;
        this.rateLimitReset = null;
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
            if (headers['x-requests-remaining'] !== undefined) {
                this.rateLimitRemaining = parseInt(headers['x-requests-remaining'], 10);
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
        return this.request('tournaments', { sport: sportId });
    }

    async getFixtures(params = {}) {
        return this.request('events', { sport: 'cricket', ...params });
    }

    async getFixturesForDate(dateStr, params = {}) {
        return this.request('events', { sport: 'cricket', from: dateStr, to: dateStr, ...params });
    }

    async getFixturesLive(params = {}) {
        return this.request('events/live', { sport: 'cricket', ...params });
    }

    async getFixturesToday(params = {}) {
        return this.request('events', { sport: 'cricket', status: 'live,pending', ...params });
    }

    async getFixtureOdds(eventId, bookmakers = []) {
        const params = { eventId };
        if (bookmakers.length > 0) {
            params.bookmakers = bookmakers.join(',');
        }
        return this.request('odds', params);
    }

    async getMarkets(params = {}) {
        return this.request('markets', params);
    }
}

module.exports = new OddsApiRest();
