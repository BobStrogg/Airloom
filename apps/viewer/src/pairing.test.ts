import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodeConnectPlan,
  DEFAULT_LOCAL_RELAY_URL,
  fetchPairingSession,
  getCodeConnectFallbacks,
  getNextStoredRelay,
  getRelayInputPlaceholder,
  INVALID_RELAY_URL_MESSAGE,
  isWebSocketRelayUrl,
  normalizeStoredRelay,
  selectCodeConnectFallback,
  canAutoReconnectSavedSession,
  type PairSessionFetcher,
  type SavedSession,
} from './pairing.js';

test('getNextStoredRelay preserves a working websocket relay across Ably pairings', () => {
  assert.equal(getNextStoredRelay('wss://relay.example/socket', 'ably'), 'wss://relay.example/socket');
});

test('getNextStoredRelay replaces the stored relay when a new websocket relay is used', () => {
  assert.equal(
    getNextStoredRelay('ws://old-relay.local:4500', '  wss://new-relay.example/socket  '),
    'wss://new-relay.example/socket',
  );
});

test('normalizeStoredRelay trims websocket relays and rejects non-websocket values', () => {
  assert.equal(normalizeStoredRelay('  ws://localhost:4500  '), 'ws://localhost:4500');
  assert.equal(normalizeStoredRelay('ably'), null);
  assert.equal(normalizeStoredRelay('https://relay.example'), null);
});

test('isWebSocketRelayUrl only accepts ws and wss relay urls', () => {
  assert.equal(isWebSocketRelayUrl('ws://localhost:4500'), true);
  assert.equal(isWebSocketRelayUrl('wss://relay.example/socket'), true);
  assert.equal(isWebSocketRelayUrl('https://relay.example/socket'), false);
  assert.equal(isWebSocketRelayUrl('relay.example/socket'), false);
});

test('getRelayInputPlaceholder only shows the localhost default on local viewer hosts', () => {
  assert.equal(
    getRelayInputPlaceholder('localhost'),
    `WebSocket relay URL (default: ${DEFAULT_LOCAL_RELAY_URL})`,
  );
  assert.equal(
    getRelayInputPlaceholder('[::1]'),
    `WebSocket relay URL (default: ${DEFAULT_LOCAL_RELAY_URL})`,
  );
  assert.equal(
    getRelayInputPlaceholder('viewer.example'),
    'WebSocket relay URL (optional for self-hosted relay)',
  );
});

test('getCodeConnectFallbacks tries a websocket relay before a saved Ably token', () => {
  const saved: SavedSession = {
    session: 'saved-session',
    token: 'ably-token',
    transport: 'ably',
    relay: 'ably',
    tokenExpiresAt: Date.now() + 60_000,
  };

  assert.deepEqual(
    getCodeConnectFallbacks({
      saved,
      relayInputValue: '  wss://manual-relay.example/socket  ',
      viewerHostname: 'viewer.example',
    }),
    [
      { kind: 'manual-relay', relay: 'wss://manual-relay.example/socket' },
      { kind: 'saved-ably', session: 'saved-session', relay: 'ably', token: 'ably-token', tokenExpiresAt: saved.tokenExpiresAt },
    ],
  );
  assert.deepEqual(
    selectCodeConnectFallback({
      saved,
      relayInputValue: '  wss://manual-relay.example/socket  ',
      viewerHostname: 'viewer.example',
    }),
    { kind: 'manual-relay', relay: 'wss://manual-relay.example/socket' },
  );
});

test('selectCodeConnectFallback uses the manual relay when no Ably token is saved', () => {
  assert.deepEqual(
    selectCodeConnectFallback({
      saved: null,
      relayInputValue: '  wss://manual-relay.example/socket  ',
      viewerHostname: 'viewer.example',
    }),
    { kind: 'manual-relay', relay: 'wss://manual-relay.example/socket' },
  );
});

test('invalid relay input does not block a saved Ably fallback', () => {
  const saved: SavedSession = {
    session: 'saved-session',
    token: 'ably-token',
    transport: 'ably',
    relay: 'ably',
    tokenExpiresAt: Date.now() + 60_000,
  };

  assert.deepEqual(
    getCodeConnectFallbacks({
      saved,
      relayInputValue: 'https://relay.example/socket',
      viewerHostname: 'viewer.example',
    }),
    [{ kind: 'saved-ably', session: 'saved-session', relay: 'ably', token: 'ably-token', tokenExpiresAt: saved.tokenExpiresAt }],
  );
  assert.deepEqual(
    selectCodeConnectFallback({
      saved,
      relayInputValue: 'https://relay.example/socket',
      viewerHostname: 'viewer.example',
    }),
    { kind: 'saved-ably', session: 'saved-session', relay: 'ably', token: 'ably-token', tokenExpiresAt: saved.tokenExpiresAt },
  );
});

test('getCodeConnectFallbacks uses the localhost websocket relay before a saved Ably token in local development', () => {
  const saved: SavedSession = {
    session: 'saved-session',
    token: 'ably-token',
    transport: 'ably',
    relay: 'ably',
    tokenExpiresAt: Date.now() + 60_000,
  };

  assert.deepEqual(
    getCodeConnectFallbacks({
      saved,
      relayInputValue: '',
      viewerHostname: '127.0.0.1',
    }),
    [
      { kind: 'default-local-ws', relay: DEFAULT_LOCAL_RELAY_URL },
      { kind: 'saved-ably', session: 'saved-session', relay: 'ably', token: 'ably-token', tokenExpiresAt: saved.tokenExpiresAt },
    ],
  );
  assert.deepEqual(
    selectCodeConnectFallback({
      saved,
      relayInputValue: '',
      viewerHostname: '127.0.0.1',
    }),
    { kind: 'default-local-ws', relay: DEFAULT_LOCAL_RELAY_URL },
  );
});

test('buildCodeConnectPlan tries the trusted pair session before websocket and Ably fallbacks', () => {
  const saved: SavedSession = {
    session: 'saved-session',
    token: 'ably-token',
    transport: 'ably',
    relay: 'ably',
    tokenExpiresAt: Date.now() + 60_000,
  };

  assert.deepEqual(
    buildCodeConnectPlan({
      pairSession: { session: 'host-session', transport: 'ws', relay: 'wss://host-relay.example/socket' },
      saved,
      relayInputValue: '  wss://manual-relay.example/socket  ',
      viewerHostname: 'viewer.example',
    }),
    {
      attempts: [
        { kind: 'pair-session', session: 'host-session', transport: 'ws', relay: 'wss://host-relay.example/socket' },
        { kind: 'manual-relay', relay: 'wss://manual-relay.example/socket' },
        { kind: 'saved-ably', session: 'saved-session', relay: 'ably', token: 'ably-token', tokenExpiresAt: saved.tokenExpiresAt },
      ],
      relayInputError: null,
    },
  );
});

test('buildCodeConnectPlan preserves pair-session and saved Ably attempts when relay input is invalid', () => {
  const saved: SavedSession = {
    session: 'saved-session',
    token: 'ably-token',
    transport: 'ably',
    relay: 'ably',
    tokenExpiresAt: Date.now() + 60_000,
  };

  assert.deepEqual(
    buildCodeConnectPlan({
      pairSession: { session: 'host-session', transport: 'ws', relay: 'wss://host-relay.example/socket' },
      saved,
      relayInputValue: 'https://relay.example/socket',
      viewerHostname: 'viewer.example',
    }),
    {
      attempts: [
        { kind: 'pair-session', session: 'host-session', transport: 'ws', relay: 'wss://host-relay.example/socket' },
        { kind: 'saved-ably', session: 'saved-session', relay: 'ably', token: 'ably-token', tokenExpiresAt: saved.tokenExpiresAt },
      ],
      relayInputError: INVALID_RELAY_URL_MESSAGE,
    },
  );
});

test('selectCodeConnectFallback falls back to the saved Ably token when no websocket path exists', () => {
  const saved: SavedSession = {
    session: 'saved-session',
    token: 'ably-token',
    transport: 'ably',
    relay: 'ably',
    tokenExpiresAt: Date.now() + 60_000,
  };

  assert.deepEqual(
    selectCodeConnectFallback({
      saved,
      relayInputValue: '',
      viewerHostname: 'viewer.example',
    }),
    { kind: 'saved-ably', session: 'saved-session', relay: 'ably', token: 'ably-token', tokenExpiresAt: saved.tokenExpiresAt },
  );
});

test('expired saved Ably sessions are not used for auto reconnect or fallback attempts', () => {
  const saved: SavedSession = {
    session: 'saved-session',
    token: 'ably-token',
    tokenExpiresAt: Date.now() - 1,
    transport: 'ably',
    relay: 'ably',
  };

  assert.equal(canAutoReconnectSavedSession(saved, Date.now()), false);
  assert.deepEqual(
    getCodeConnectFallbacks({
      saved,
      relayInputValue: '',
      viewerHostname: 'viewer.example',
    }),
    [],
  );
});

test('selectCodeConnectFallback returns unavailable when no fallback path exists', () => {
  assert.deepEqual(
    selectCodeConnectFallback({
      saved: null,
      relayInputValue: '',
      viewerHostname: 'viewer.example',
    }),
    { kind: 'unavailable' },
  );
});

test('fetchPairingSession uses the trusted origin and validates the response shape', async () => {
  const calls: string[] = [];
  const fetchImpl: PairSessionFetcher = async (input) => {
    calls.push(input);
    return {
      ok: true,
      async json() {
        return { session: 'host-session', transport: 'ws', relay: 'wss://relay.example/socket' };
      },
    };
  };

  const result = await fetchPairingSession(fetchImpl, 'https://viewer.example', 'code/with spaces');
  assert.deepEqual(calls, ['https://viewer.example/api/pair?session=code%2Fwith%20spaces']);
  assert.deepEqual(result, { session: 'host-session', transport: 'ws', relay: 'wss://relay.example/socket' });
});

test('fetchPairingSession rejects invalid pairing responses from the host api', async () => {
  const fetchImpl: PairSessionFetcher = async () => ({
    ok: true,
    async json() {
      return { transport: 'ably', relay: 'ably' };
    },
  });

  assert.equal(await fetchPairingSession(fetchImpl, 'https://viewer.example', 'session'), null);
});
