const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Set dummy env variables for testing if not set
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret123';
process.env.NODE_ENV = 'production'; // enforce production origin checking in tests

const app = require('../server.js');
const apiHandler = require('../api/index.js');

// Helper to simulate request through Express app
function dispatchRequest(app, options) {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage();
    req.method = options.method || 'GET';
    req.url = options.url || '/';
    req.headers = Object.fromEntries(
      Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    );

    const res = new http.ServerResponse(req);
    const headers = {};
    let responseBody = '';

    res.setHeader = (k, v) => {
      headers[k.toLowerCase()] = v;
    };
    res.getHeader = (k) => headers[k.toLowerCase()];
    res.writeHead = (status, reasonOrHeaders, maybeHeaders) => {
      res.statusCode = status;
      const hdrs = typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = v;
        }
      }
    };

    res.write = (chunk) => {
      if (chunk) responseBody += chunk.toString();
      return true;
    };

    res.end = (chunk) => {
      if (chunk) responseBody += chunk.toString();
      resolve({
        statusCode: res.statusCode || 200,
        headers,
        body: responseBody
      });
    };

    try {
      app(req, res);
      if (options.body) {
        req.emit('data', Buffer.from(options.body));
        req.emit('end');
      } else {
        req.emit('end');
      }
    } catch (err) {
      reject(err);
    }
  });
}

describe('BetPro Exchange CORS & Entry Point Suite', () => {
  it('api/index.js correctly exports the Express application', () => {
    assert.equal(typeof apiHandler, 'function');
    assert.equal(typeof apiHandler.use, 'function');
    assert.equal(typeof apiHandler.post, 'function');
  });

  it('OPTIONS preflight from https://www.betproexchange.site returns 204 with correct CORS headers', async () => {
    const res = await dispatchRequest(app, {
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: {
        'Origin': 'https://www.betproexchange.site',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization'
      }
    });

    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'https://www.betproexchange.site');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
    assert.ok(res.headers['access-control-allow-methods'].includes('GET'));
    assert.ok(res.headers['access-control-allow-methods'].includes('POST'));
    assert.ok(res.headers['access-control-allow-methods'].includes('PUT'));
    assert.ok(res.headers['access-control-allow-methods'].includes('PATCH'));
    assert.ok(res.headers['access-control-allow-methods'].includes('DELETE'));
    assert.ok(res.headers['access-control-allow-methods'].includes('OPTIONS'));
    assert.ok(res.headers['access-control-allow-headers'].toLowerCase().includes('content-type'));
    assert.ok(res.headers['access-control-allow-headers'].toLowerCase().includes('authorization'));
  });

  it('OPTIONS preflight from https://betproexchange.site returns 204 with correct CORS headers', async () => {
    const res = await dispatchRequest(app, {
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: {
        'Origin': 'https://betproexchange.site',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization'
      }
    });

    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'https://betproexchange.site');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });

  it('OPTIONS preflight from unauthorized origin is NOT granted access-control-allow-origin', async () => {
    const res = await dispatchRequest(app, {
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: {
        'Origin': 'https://unauthorized-attacker.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization'
      }
    });

    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('Actual POST to /api/auth/login from https://www.betproexchange.site includes CORS headers', async () => {
    const res = await dispatchRequest(app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'Origin': 'https://www.betproexchange.site',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username: 'testuser', password: 'password123' })
    });

    assert.equal(res.headers['access-control-allow-origin'], 'https://www.betproexchange.site');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });

  it('Actual POST to /api/auth/login from https://betproexchange.site includes CORS headers', async () => {
    const res = await dispatchRequest(app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'Origin': 'https://betproexchange.site',
        'Content-Type': 'application/json'
      }
    });

    assert.equal(res.headers['access-control-allow-origin'], 'https://betproexchange.site');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });

  it('Actual POST from unauthorized origin does NOT receive access-control-allow-origin', async () => {
    const res = await dispatchRequest(app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'Origin': 'https://phishing-site.xyz',
        'Content-Type': 'application/json'
      }
    });

    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('404 error response contains appropriate CORS headers for authorized origins', async () => {
    const res = await dispatchRequest(app, {
      method: 'GET',
      url: '/api/non-existent-endpoint',
      headers: {
        'Origin': 'https://www.betproexchange.site'
      }
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['access-control-allow-origin'], 'https://www.betproexchange.site');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });
});
