import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackBind, parseHostEnv } from './env.js';

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('parseHostEnv defaults to localhost-only hosting with the community Ably relay', () => {
  withEnv({
    RELAY_URL: undefined,
    ABLY_API_KEY: undefined,
    ABLY_TOKEN_TTL: undefined,
    HOST_PORT: undefined,
    HOST_BIND: undefined,
    VIEWER_URL: undefined,
  }, () => {
    const env = parseHostEnv();
    assert.equal(env.hostBind, '127.0.0.1');
    assert.equal(env.hostPort, 0);
    assert.equal(env.useAbly, true);
    assert.equal(env.isDefaultAblyKey, true);
    assert.equal(env.viewerUrl, 'https://bobstrogg.github.io/Airloom/');
  });
});

test('parseHostEnv respects a self-hosted relay and disables the default Ably key', () => {
  withEnv({
    RELAY_URL: 'wss://relay.example/socket',
    ABLY_API_KEY: undefined,
    HOST_BIND: '0.0.0.0',
    HOST_PORT: '4100',
    VIEWER_URL: 'https://viewer.example/app/',
  }, () => {
    const env = parseHostEnv();
    assert.equal(env.relayUrl, 'wss://relay.example/socket');
    assert.equal(env.useAbly, false);
    assert.equal(env.ablyApiKey, undefined);
    assert.equal(env.hostBind, '0.0.0.0');
    assert.equal(env.hostPort, 4100);
    assert.equal(env.viewerUrl, 'https://viewer.example/app/');
  });
});

test('parseHostEnv rejects invalid ports and relay urls', () => {
  withEnv({ HOST_PORT: '99999' }, () => {
    assert.throws(() => parseHostEnv(), { message: 'HOST_PORT must be an integer between 0 and 65535' });
  });
  withEnv({ HOST_PORT: undefined, RELAY_URL: 'https://relay.example/socket' }, () => {
    assert.throws(() => parseHostEnv(), { message: 'RELAY_URL must use ws:// or wss://' });
  });
});

test('isLoopbackBind detects localhost-only binds', () => {
  assert.equal(isLoopbackBind('127.0.0.1'), true);
  assert.equal(isLoopbackBind('::1'), true);
  assert.equal(isLoopbackBind('localhost'), true);
  assert.equal(isLoopbackBind('0.0.0.0'), false);
});
