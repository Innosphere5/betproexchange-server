const axios = require('axios');
require('dotenv').config();

const BASE_URL = 'https://v5.oddspapi.io/en';

class OddsPapiRest {
    constructor() {
        this.apiKey = process.env.ODDS_API_KEY;
        this.rateLimitRemaining = null;
        this.rateLimitReset = null;
    }

    async request(endpoint, params = {}) {
        if (!this.apiKey) {
            throw new Error('[OddsPapi REST] Missing ODDS_API_KEY');
        }

        if (this.rateLimitRemaining !== null && this.rateLimitRemaining <= 0) {
            const now = Math.floor(Date.now() / 1000);
            if (this.rateLimitReset && now < this.rateLimitReset) {
                const waitSec = this.rateLimitReset - now;
                console.warn(`[OddsPapi REST] Rate limited. Waiting ${waitSec}s...`);
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
                console.warn(`[OddsPapi REST] 429 Rate limited. Retry after ${retryAfter}s`);
            }
            throw err;
        }
    }

    async getSports() {
        return this.request('sports');
    }

    async getTournaments(sportId) {
        return this.request('tournaments', { sportId });
    }

    async getFixtures(params = {}) {
        return this.request('fixtures', params);
    }

    async getFixturesForDate(dateStr, params = {}) {
        // dateStr: 'YYYY-MM-DD' — fetches all fixtures scheduled on that date
        return this.request('fixtures', { date: dateStr, ...params });
    }

    async getFixturesLive(params = {}) {
        return this.request('fixtures/live', params);
    }

    async getFixturesToday(params = {}) {
        return this.request('fixtures/today', params);
    }

    async getFixtureOdds(fixtureId, bookmakers = []) {
        const params = { fixtureId };
        if (bookmakers.length > 0) {
            params.bookmakers = bookmakers.join(',');
        }
        return this.request('fixtures/odds', params);
    }

    async getFixtureOddsMain(params = {}) {
        if (params.bookmakers && Array.isArray(params.bookmakers)) {
            params.bookmakers = params.bookmakers.join(',');
        }
        return this.request('fixtures/odds/main', params);
    }

    async getMarkets(params = {}) {
        return this.request('markets', params);
    }
}

module.exports = new OddsPapiRest();
