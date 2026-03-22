import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_COOKIE_NAME, createControlToken, encodeControlUrl, hasAllowedOrigin, hasValidControlToken, parseCookies, readControlToken, type RequestLike } from './security.js';

test('parseCookies handles multiple cookie values', () => {
  assert.deepEqual(
    parseCookies(`${CONTROL_COOKIE_NAME}=secret; theme=dark`),
    { [CONTROL_COOKIE_NAME]: 'secret', theme: 'dark' },
  );
});

test('readControlToken prefers headers, then query, then cookies', () => {
  const queryReq: RequestLike = {
    headers: { host: 'localhost:3000' },
    query: { t: 'query-token' },
  };
  const cookieReq: RequestLike = {
    headers: { host: 'localhost:3000', cookie: `${CONTROL_COOKIE_NAME}=cookie-token` },
  };
  const headerReq: RequestLike = {
    headers: { host: 'localhost:3000', 'x-airloom-control': 'header-token', cookie: `${CONTROL_COOKIE_NAME}=cookie-token` },
    query: { t: 'query-token' },
  };
  assert.equal(readControlToken(queryReq), 'query-token');
  assert.equal(readControlToken(cookieReq), 'cookie-token');
  assert.equal(readControlToken(headerReq), 'header-token');
});

test('hasValidControlToken matches the expected token and rejects others', () => {
  const token = createControlToken();
  const req: RequestLike = {
    headers: { host: 'localhost:3000', cookie: `${CONTROL_COOKIE_NAME}=${token}` },
  };
  assert.equal(hasValidControlToken(req, token), true);
  assert.equal(hasValidControlToken(req, token + 'x'), false);
});

test('hasAllowedOrigin only accepts the current host origin when present', () => {
  assert.equal(hasAllowedOrigin({ origin: 'http://localhost:3000' }, 'localhost:3000'), true);
  assert.equal(hasAllowedOrigin({ origin: 'https://localhost:3000' }, 'localhost:3000'), true);
  assert.equal(hasAllowedOrigin({ origin: 'https://evil.example' }, 'localhost:3000'), false);
  assert.equal(hasAllowedOrigin({}, 'localhost:3000'), true);
});

test('encodeControlUrl appends the control token as a query parameter', () => {
  assert.equal(
    encodeControlUrl('http://localhost:3000', 'secret'),
    'http://localhost:3000/?t=secret',
  );
});
