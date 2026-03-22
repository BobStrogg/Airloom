import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePairingInput, encodePairingData, parsePairingInput } from './codec.js';
import type { PairingData } from './types.js';

const sample: PairingData = {
  relay: 'ably',
  session: '0123456789abcdef0123456789abcdef',
  pub: 'Zm9v',
  v: 1,
  transport: 'ably',
  token: 'ably-token',
  tokenExpiresAt: 1234567890,
};

function toBase64Url(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function toPaddedBase64Url(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

test('decodePairingInput accepts raw JSON pairing data', () => {
  assert.deepEqual(decodePairingInput(encodePairingData(sample)), sample);
  assert.deepEqual(parsePairingInput(encodePairingData(sample)), sample);
});

test('parsePairingInput accepts raw JSON with surrounding whitespace', () => {
  assert.deepEqual(parsePairingInput(`  ${encodePairingData(sample)}  `), sample);
});

test('decodePairingInput accepts raw base64url pairing data', () => {
  const encoded = toBase64Url(encodePairingData(sample));
  assert.deepEqual(decodePairingInput(encoded), sample);
});

test('decodePairingInput accepts padded base64url pairing data', () => {
  const encoded = toPaddedBase64Url(encodePairingData(sample));
  assert.deepEqual(decodePairingInput(encoded), sample);
});

test('decodePairingInput accepts a full QR URL with hash payload', () => {
  const encoded = toBase64Url(encodePairingData(sample));
  const qrUrl = `https://example.com/viewer/#${encoded}`;
  assert.deepEqual(decodePairingInput(qrUrl), sample);
  assert.deepEqual(parsePairingInput(qrUrl), sample);
});

test('parsePairingInput ignores QR URL path and query metadata', () => {
  const encoded = toBase64Url(encodePairingData(sample));
  const qrUrl = `https://example.com/viewer/?utm_source=test#${encoded}`;
  assert.deepEqual(parsePairingInput(`  ${qrUrl}  `), sample);
});

test('decodePairingInput accepts a bare hash fragment payload', () => {
  const encoded = toBase64Url(encodePairingData(sample));
  assert.deepEqual(decodePairingInput(`#${encoded}`), sample);
});

test('decodePairingInput accepts whitespace around encoded payloads', () => {
  const encoded = toBase64Url(encodePairingData(sample));
  assert.deepEqual(decodePairingInput(`  ${encoded}  `), sample);
});

test('parsePairingInput rejects QR URLs without a hash payload', () => {
  assert.throws(() => parsePairingInput('https://example.com/viewer/'), {
    message: 'Invalid pairing data: URL is missing a hash payload',
  });
});

test('parsePairingInput rejects empty input', () => {
  assert.throws(() => parsePairingInput('   '), {
    message: 'Invalid pairing data: empty input',
  });
});

test('parsePairingInput rejects empty hash fragments', () => {
  assert.throws(() => parsePairingInput('#'), {
    message: 'Invalid pairing data: empty hash payload',
  });
});

test('parsePairingInput rejects malformed QR URLs', () => {
  assert.throws(() => parsePairingInput('https://exa mple.com/#payload'), {
    message: 'Invalid pairing data: malformed QR URL',
  });
});

test('parsePairingInput rejects malformed encoded payloads', () => {
  assert.throws(() => parsePairingInput('not-base64'), {
    message: 'Invalid pairing data: malformed encoded payload',
  });
});

test('parsePairingInput rejects non-numeric token expiry values', () => {
  const invalid = {
    ...sample,
    tokenExpiresAt: 'tomorrow',
  };
  assert.throws(() => parsePairingInput(encodePairingData(invalid as unknown as PairingData)), {
    message: 'Invalid pairing data: tokenExpiresAt must be a number',
  });
});

test('parsePairingInput rejects encoded payloads with extra non-base64url characters', () => {
  const encoded = toBase64Url(encodePairingData(sample));

  for (const input of [
    `!!!!${encoded}`,
    `${encoded}!!!`,
    `#!!!!${encoded}`,
    `https://example.com/viewer/#${encoded}!!!`,
  ]) {
    assert.throws(() => parsePairingInput(input), {
      message: 'Invalid pairing data: malformed encoded payload',
    });
  }
});
