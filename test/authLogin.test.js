const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret123';
process.env.NODE_ENV = 'test';

const app = require('../server.js');

function dispatchRequest(app, options) {
  return new Promise((resolve) => {
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

    if (options.body) {
      process.nextTick(() => {
        req.emit('data', Buffer.from(options.body));
        req.emit('end');
      });
    } else {
      process.nextTick(() => {
        req.emit('end');
      });
    }

    app(req, res);
  });
}

describe('🔐 Auth Login Hardening & Error Handling Suite', () => {
  it('1. Rejects login request with empty body with 400 instead of 500', async () => {
    const res = await dispatchRequest(app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'content-type': 'application/json',
        'origin': 'https://betproexchange.site'
      },
      body: JSON.stringify({})
    });

    assert.equal(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.equal(data.error, 'Username and password are required');
  });

  it('2. Rejects login request with missing password with 400', async () => {
    const res = await dispatchRequest(app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'content-type': 'application/json',
        'origin': 'https://betproexchange.site'
      },
      body: JSON.stringify({ username: 'Adnan' })
    });

    assert.equal(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.equal(data.error, 'Username and password are required');
  });

  it('3. Rejects register request with missing fields with 400 instead of 500', async () => {
    const res = await dispatchRequest(app, {
      method: 'POST',
      url: '/api/auth/register',
      headers: {
        'content-type': 'application/json',
        'origin': 'https://betproexchange.site'
      },
      body: JSON.stringify({})
    });

    assert.equal(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.equal(data.error, 'Username and password are required');
  });
});

