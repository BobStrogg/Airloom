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
  if (data.transport === 'ably' && !data.token) {
    throw new Error('Invalid pairing data: Ably transport requires a token');
  }
  return data as PairingData;
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
