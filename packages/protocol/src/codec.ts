import type { RelayMessage, ChannelMessage, PairingData } from './types.js';

// Base64 encoding/decoding that works in both Node and browser
export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(str: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(str, 'base64'));
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Relay message codec (JSON over WebSocket)
export function encodeRelayMessage(msg: RelayMessage): string {
  return JSON.stringify(msg);
}

export function decodeRelayMessage(data: string): RelayMessage {
  const msg = JSON.parse(data);
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    throw new Error('Invalid relay message: missing type field');
  }
  return msg as RelayMessage;
}

// Channel message codec (JSON, then encrypted)
export function encodeChannelMessage(msg: ChannelMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

export function decodeChannelMessage(data: Uint8Array): ChannelMessage {
  const msg = JSON.parse(new TextDecoder().decode(data));
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || typeof msg.id !== 'string') {
    throw new Error('Invalid channel message: missing type or id field');
  }
  return msg as ChannelMessage;
}

// Pairing data codec
export function encodePairingData(data: PairingData): string {
  return JSON.stringify(data);
}

export function decodePairingData(str: string): PairingData {
  const data = JSON.parse(str);
  if (!data || typeof data !== 'object' || typeof data.relay !== 'string' || typeof data.session !== 'string' || typeof data.v !== 'number') {
    throw new Error('Invalid pairing data: missing required fields');
  }
  if (data.transport !== undefined && data.transport !== 'ws' && data.transport !== 'ably') {
    throw new Error('Invalid pairing data: transport must be "ws" or "ably"');
  }
  if (data.token !== undefined && typeof data.token !== 'string') {
    throw new Error('Invalid pairing data: token must be a string');
  }
  if (data.tokenExpiresAt !== undefined && typeof data.tokenExpiresAt !== 'number') {
    throw new Error('Invalid pairing data: tokenExpiresAt must be a number');
  }
  if (data.transport === 'ably' && !data.token) {
    throw new Error('Invalid pairing data: Ably transport requires a token');
  }
  return data as PairingData;
}

const BASE64_URL_PAYLOAD_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function isValidBase64UrlPayload(str: string): boolean {
  if (!BASE64_URL_PAYLOAD_RE.test(str)) return false;
  const paddingLength = str.match(/=+$/)?.[0].length ?? 0;
  const unpaddedLength = str.length - paddingLength;
  if (unpaddedLength === 0) return false;

  const remainder = unpaddedLength % 4;
  if (remainder === 1) return false;
  if (paddingLength === 1) return remainder === 3;
  if (paddingLength === 2) return remainder === 2;
  return paddingLength === 0;
}

function decodeBase64UrlUtf8(str: string): string {
  if (!isValidBase64UrlPayload(str)) {
    throw new Error('Invalid pairing data: malformed encoded payload');
  }
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return utf8Decoder.decode(fromBase64(padded));
}

function decodeEncodedPairingData(encoded: string): PairingData {
  try {
    return decodePairingData(decodeBase64UrlUtf8(encoded));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid pairing data:')) {
      throw err;
    }
    throw new Error('Invalid pairing data: malformed encoded payload');
  }
}

/**
 * Decode pairing input from any viewer entry point.
 *
 * Supported forms:
 * - Raw JSON pairing payload
 * - Base64url-encoded pairing payload
 * - Full QR URL ending in `#<base64url-payload>`
 * - Raw hash fragment (with or without leading `#`)
 *
 * For QR URLs, only the hash payload is trusted; path, query, and origin are
 * treated as transport details for opening the viewer, not pairing metadata.
 */
export function parsePairingInput(input: string): PairingData {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Invalid pairing data: empty input');
  }
  if (trimmed.startsWith('{')) {
    return decodePairingData(trimmed);
  }

  if (trimmed.startsWith('#')) {
    const encoded = trimmed.slice(1);
    if (!encoded) {
      throw new Error('Invalid pairing data: empty hash payload');
    }
    return decodeEncodedPairingData(encoded);
  }

  if (trimmed.includes('://')) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error('Invalid pairing data: malformed QR URL');
    }
    const encoded = url.hash.slice(1);
    if (!encoded) {
      throw new Error('Invalid pairing data: URL is missing a hash payload');
    }
    return decodeEncodedPairingData(encoded);
  }

  return decodeEncodedPairingData(trimmed);
}

export function decodePairingInput(input: string): PairingData {
  return parsePairingInput(input);
}

// Generate a random alphanumeric string
export function randomCode(length: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I/L)
  const limit = 256 - (256 % chars.length); // rejection sampling threshold
  const result: string[] = [];
  while (result.length < length) {
    const bytes = getRandomBytes(length - result.length + 8); // over-request to reduce loops
    for (const b of bytes) {
      if (b >= limit) continue; // reject biased values
      result.push(chars[b % chars.length]);
      if (result.length === length) break;
    }
  }
  return result.join('');
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // globalThis.crypto available in Node 19+ and all modern browsers
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  throw new Error('No crypto implementation available. Requires Node.js >= 18 or a browser with Web Crypto API.');
}
