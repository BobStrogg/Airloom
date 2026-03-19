import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { toBase64, randomCode } from '@airloom/protocol';
import { generateKeyPair, type KeyPair } from './keypair.js';
import type { PairingData, SessionInfo } from '@airloom/protocol';

// Create a new session (host side)
export function createSession(relayUrl: string): SessionInfo & { pairingData: PairingData } {
  const keyPair = generateKeyPair();
  const pairingCode = randomCode(8); // 8-char code
  const sessionToken = deriveSessionToken(pairingCode);

  const pairingData: PairingData = {
    relay: relayUrl,
    session: sessionToken,
    pub: toBase64(keyPair.publicKey),
    v: 1,
  };

  return {
    sessionToken,
    pairingCode,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.secretKey,
    pairingData,
  };
}

// Derive a session token from a pairing code (used for relay lookup)
// The relay sees this token but not the code itself
export function deriveSessionToken(pairingCode: string): string {
  const hash = sha256(new TextEncoder().encode(`airloom-session:${pairingCode}`));
  // Return first 16 bytes as hex
  return Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Derive an encryption key from the pairing code (code-based pairing)
// This key is used when QR pairing provides the public key out-of-band
export function deriveEncryptionKey(
  sharedSecret: Uint8Array,
  salt?: Uint8Array,
): Uint8Array {
  const defaultSalt = new TextEncoder().encode('airloom-v1');
  return hkdf(sha256, sharedSecret, salt ?? defaultSalt, 'airloom-encryption', 32);
}

// Format pairing code for display: ABCD-EFGH
export function formatPairingCode(code: string): string {
  if (code.length <= 4) return code;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// Parse a displayed pairing code back (remove dashes/spaces)
export function parsePairingCode(displayed: string): string {
  return displayed.replace(/[-\s]/g, '').toUpperCase();
}
