import nacl from 'tweetnacl';

const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;

// Encrypt plaintext with a symmetric key using XSalsa20-Poly1305
export function encrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const ciphertext = nacl.secretbox(plaintext, nonce, key);
  // Prepend nonce to ciphertext: [nonce (24B) | ciphertext (N + 16B)]
  const sealed = new Uint8Array(NONCE_LENGTH + ciphertext.length);
  sealed.set(nonce);
  sealed.set(ciphertext, NONCE_LENGTH);
  return sealed;
}

// Decrypt sealed data (nonce + ciphertext) with a symmetric key
export function decrypt(sealed: Uint8Array, key: Uint8Array): Uint8Array {
  if (sealed.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new Error('Sealed data too short');
  }
  const nonce = sealed.slice(0, NONCE_LENGTH);
  const ciphertext = sealed.slice(NONCE_LENGTH);
  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
  if (!plaintext) {
    throw new Error('Decryption failed - data may be tampered with');
  }
  return plaintext;
}

// Encrypt a UTF-8 string
export function encryptString(plaintext: string, key: Uint8Array): Uint8Array {
  return encrypt(new TextEncoder().encode(plaintext), key);
}

// Decrypt to a UTF-8 string
export function decryptString(sealed: Uint8Array, key: Uint8Array): string {
  return new TextDecoder().decode(decrypt(sealed, key));
}
