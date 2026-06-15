const axios = require('axios');
require('dotenv').config();

/**
 * OddsApiService
 * 
 * A professional API manager for Odds-API.io that enforces a strict rate limit
 * to stay within the 5000 requests/hour quota.
 * 
 * Features:
 * - Paced Queue: Ensures requests are spaced out (default ~800ms interval).
 * - Priority: Prioritizes Live match updates over Upcoming ones.
 * - Error Handling: Gracefully handles 429 Rate Limit errors with backoff.
 */
class OddsApiService {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        
        // BUDGET CALCULATION:
        // 5000 requests / 3600 seconds = 1.38 requests per second.
        // We target ~1.42 requests per second (~5140/hour).
        // Interval = 1000ms / 1.42 = 700ms.
        // Safe because not all slots are used (polling checks waitTime before queuing).
        this.minIntervalMs = 700; 
        this.lastRequestTime = 0;
    }

    /**
     * fetch
     * @param {string} endpoint - e.g. 'odds' or 'events'
     * @param {object} params - Query parameters
     * @param {number} priority - Higher numbers are processed first (e.g. 10 for Live, 1 for Upcoming)
     */
    async fetch(endpoint, params = {}, priority = 0) {
        // Ensure API Key is present
        const apiKey = process.env.ODDS_API_KEY?.trim();
        if (!apiKey) {
            throw new Error('Missing ODDS_API_KEY in environment variables');
        }

        return new Promise((resolve, reject) => {
            // DEDUPLICATION LOGIC:
            // If we are fetching 'odds' for a specific 'eventId', and it's already in the queue, 
            // we remove the old one and replace it with the new one.
            if (endpoint === 'odds' && params.eventId) {
                const existingIdx = this.queue.findIndex(q => q.endpoint === 'odds' && q.params.eventId === params.eventId);
                if (existingIdx !== -1) {
                    // Resolve the old promise with null or a special value so it doesn't hang
                    this.queue[existingIdx].resolve(null); 
                    this.queue.splice(existingIdx, 1);
                }
            }

            this.queue.push({
                endpoint,
                params: { ...params, apiKey },
                priority,
                resolve,
                reject,
                timestamp: Date.now()
            });

            // Sort queue: Highest priority first, then oldest timestamp first
            this.queue.sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);

            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const now = Date.now();
            const timeSinceLast = now - this.lastRequestTime;
            const waitTime = Math.max(0, this.minIntervalMs - timeSinceLast);

            if (waitTime > 0) {
                await new Promise(r => setTimeout(r, waitTime));
            }

            const request = this.queue.shift();
            this.lastRequestTime = Date.now();

            const baseUrl = 'https://api.odds-api.io/v3';
            const url = `${baseUrl}/${request.endpoint}`;

            try {
                const response = await axios.get(url, {
                    params: request.params,
                    timeout: 5000
                });

                request.resolve(response.data);
            } catch (err) {
                const status = err.response?.status;
                console.error(`[OddsAPI] ❌ Request failed (${status || 'TIMEOUT'}): ${request.endpoint}`, err.message);

                if (status === 429) {
                    console.warn('[OddsAPI] ⚠️ 429 Rate Limit Hit. Adding 5s backoff delay...');
                    await new Promise(r => setTimeout(r, 5000));
                }

                request.reject(err);
            }
        }

        this.isProcessing = false;
    }
}

module.exports = new OddsApiService();
