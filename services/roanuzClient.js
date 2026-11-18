const axios = require('axios');

class RoanuzClient {
  constructor() {
    this.projectKey = process.env.ROANUZ_PROJECT_KEY || 'RS_P_2116179427653193740';
    this.apiKey = process.env.ROANUZ_API_KEY || 'RS5:ce5d8bd1983f35ecf5f87a416378e75f';
    this.baseUrl = 'https://api.sports.roanuz.com/v5';
    this.authToken = null;
    this.tokenExpiresAt = 0;
    this.authPromise = null;
  }

  /**
   * Acquire or refresh the Roanuz v5 Authentication token.
   * Tokens are valid for 24 hours. We auto-refresh 1 hour before expiry.
   */
  async getAuthToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.authToken && now < this.tokenExpiresAt - 3600000) {
      return this.authToken;
    }

    if (this.authPromise) {
      return this.authPromise;
    }

    this.authPromise = (async () => {
      try {
        const authUrl = `${this.baseUrl}/core/${this.projectKey}/auth/`;
        const res = await axios.post(
          authUrl,
          { api_key: this.apiKey },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
          }
        );

        if (res.data && res.data.data && res.data.data.token) {
          this.authToken = res.data.data.token;
          // data.expires is unix timestamp in seconds
          this.tokenExpiresAt = (res.data.data.expires || (Math.floor(now / 1000) + 86400)) * 1000;
          console.log(`[Roanuz] 🔑 Successfully authenticated. Token active until ${new Date(this.tokenExpiresAt).toISOString()}`);
          return this.authToken;
        } else {
          throw new Error('Roanuz auth response missing data.token');
        }
      } catch (err) {
        console.error('[Roanuz] ❌ Authentication failed:', err.response?.data || err.message);
        throw err;
      } finally {
        this.authPromise = null;
      }
    })();

    return this.authPromise;
  }

  /**
   * Generic authenticated request to Roanuz Cricket API v5
   */
  async request(endpoint, options = {}, retries = 2) {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = `${this.baseUrl}/cricket/${this.projectKey}/${cleanEndpoint}`;

    try {
      const token = await this.getAuthToken();
      const res = await axios({
        url,
        method: options.method || 'GET',
        headers: {
          'rs-token': token,
          'Accept': 'application/json',
          ...(options.headers || {})
        },
        params: options.params || {},
        data: options.data,
        timeout: options.timeout || 8000
      });

      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if ((status === 401 || status === 403) && retries > 0) {
        console.warn(`[Roanuz] Token rejected (HTTP ${status}). Refreshing token and retrying...`);
        this.authToken = null;
        await this.getAuthToken(true);
        return this.request(endpoint, options, retries - 1);
      }
      throw err;
    }
  }

  /**
   * Fetch month fixtures from Roanuz
   */
  async getFixtures() {
    return this.request('fixtures/');
  }

  /**
   * Fetch featured tournaments
   */
  async getFeaturedTournaments() {
    return this.request('featured-tournaments/');
  }

  /**
   * Fetch full match overview, squads, toss, and live score
   * @param {string} matchKey e.g. "a-rz--cricket--w22089667654418862089"
   */
  async getMatch(matchKey) {
    if (!matchKey) throw new Error('matchKey is required');
    return this.request(`match/${matchKey}/`);
  }

  /**
   * Fetch real-time ball-by-ball commentary and balls for current over
   * @param {string} matchKey
   */
  async getBallByBall(matchKey) {
    if (!matchKey) throw new Error('matchKey is required');
    return this.request(`match/${matchKey}/ball-by-ball/`);
  }
}

module.exports = new RoanuzClient();

