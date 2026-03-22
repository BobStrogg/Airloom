import type { SavedSession } from './pairing.js';

const DB_NAME = 'airloom-secure-store';
const DB_VERSION = 1;
const META_STORE = 'meta';
const RECORD_STORE = 'records';
const WRAP_KEY_ID = 'wrap-key';
const LAST_SESSION_ID = 'last-session';
const LEGACY_LAST_SESSION_KEY = 'airloom:lastSession';

interface EncryptedSessionRecord {
  version: 1;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

function supportsSecureSessionStorage(): boolean {
  return typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle;
}

function isSavedSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (typeof data.session !== 'string' || typeof data.relay !== 'string') return false;
  if (data.transport !== 'ws' && data.transport !== 'ably') return false;
  if (data.token !== undefined && typeof data.token !== 'string') return false;
  if (data.tokenExpiresAt !== undefined && typeof data.tokenExpiresAt !== 'number') return false;
  return true;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(RECORD_STORE)) db.createObjectStore(RECORD_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function getOrCreateWrapKey(db: IDBDatabase): Promise<CryptoKey> {
  const tx = db.transaction(META_STORE, 'readwrite');
  const store = tx.objectStore(META_STORE);
  const existing = await requestToPromise(store.get(WRAP_KEY_ID));
  if (existing instanceof CryptoKey) {
    await transactionComplete(tx);
    return existing;
  }
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  store.put(key, WRAP_KEY_ID);
  await transactionComplete(tx);
  return key;
}

async function encryptSavedSession(key: CryptoKey, saved: SavedSession): Promise<EncryptedSessionRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(saved));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    version: 1,
    iv: iv.buffer.slice(0),
    ciphertext,
  };
}

async function decryptSavedSession(key: CryptoKey, record: EncryptedSessionRecord): Promise<SavedSession | null> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
    key,
    record.ciphertext,
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
  return isSavedSession(parsed) ? parsed : null;
}

async function readRecord(db: IDBDatabase): Promise<EncryptedSessionRecord | null> {
  const tx = db.transaction(RECORD_STORE, 'readonly');
  const record = await requestToPromise(tx.objectStore(RECORD_STORE).get(LAST_SESSION_ID));
  await transactionComplete(tx);
  if (!record || typeof record !== 'object') return null;
  const data = record as Partial<EncryptedSessionRecord>;
  if (data.version !== 1 || !(data.iv instanceof ArrayBuffer) || !(data.ciphertext instanceof ArrayBuffer)) {
    return null;
  }
  return data as EncryptedSessionRecord;
}

async function writeRecord(db: IDBDatabase, record: EncryptedSessionRecord): Promise<void> {
  const tx = db.transaction(RECORD_STORE, 'readwrite');
  tx.objectStore(RECORD_STORE).put(record, LAST_SESSION_ID);
  await transactionComplete(tx);
}

function readLegacySavedSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(LEGACY_LAST_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isSavedSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clearLegacySavedSession(): void {
  try {
    localStorage.removeItem(LEGACY_LAST_SESSION_KEY);
  } catch {}
}

async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {}
}

export async function saveSavedSession(saved: SavedSession): Promise<void> {
  if (!supportsSecureSessionStorage()) return;
  const db = await openDatabase();
  try {
    const key = await getOrCreateWrapKey(db);
    const record = await encryptSavedSession(key, saved);
    await writeRecord(db, record);
  } finally {
    db.close();
  }
  clearLegacySavedSession();
  await requestPersistentStorage();
}

export async function loadSavedSession(): Promise<SavedSession | null> {
  if (!supportsSecureSessionStorage()) return null;
  const legacy = readLegacySavedSession();
  if (legacy) {
    await saveSavedSession(legacy);
    return legacy;
  }
  const db = await openDatabase();
  try {
    const record = await readRecord(db);
    if (!record) return null;
    const key = await getOrCreateWrapKey(db);
    return await decryptSavedSession(key, record);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function clearSavedSession(): Promise<void> {
  clearLegacySavedSession();
  if (!supportsSecureSessionStorage()) return;
  const db = await openDatabase();
  try {
    const tx = db.transaction(RECORD_STORE, 'readwrite');
    tx.objectStore(RECORD_STORE).delete(LAST_SESSION_ID);
    await transactionComplete(tx);
  } finally {
    db.close();
  }
}
