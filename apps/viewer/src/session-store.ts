import type { SavedSession } from './pairing.js';

// Session persistence: stores relay credentials so the viewer can reconnect
// after a home-screen launch without rescanning the QR code.
//
// Strategy: write to ALL three stores on save (cookie, IndexedDB, localStorage),
// read the first hit on load. The cookie is critical because iOS standalone web
// apps (apple-mobile-web-app-capable) have isolated IndexedDB/localStorage from
// regular Safari, but cookies ARE shared between the two contexts.

const DB_NAME = 'airloom-session-store';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const LAST_SESSION_ID = 'last-session';
const LS_SESSION_KEY = 'airloom:session';
const COOKIE_NAME = 'airloom_session';
const LEGACY_LAST_SESSION_KEY = 'airloom:lastSession';
// Cookie max-age: 30 days (the Ably token inside expires much sooner, but we
// check that separately in canAutoReconnectSavedSession).
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

function isSavedSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (typeof data.session !== 'string' || typeof data.relay !== 'string') return false;
  if (data.transport !== 'ws' && data.transport !== 'ably') return false;
  if (data.token !== undefined && typeof data.token !== 'string') return false;
  if (data.tokenExpiresAt !== undefined && typeof data.tokenExpiresAt !== 'number') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Cookie helpers (bridges Safari ↔ standalone web app storage gap on iOS)
// ---------------------------------------------------------------------------

function cookieSave(saved: SavedSession): void {
  try {
    const json = JSON.stringify(saved);
    const encoded = encodeURIComponent(json);
    document.cookie = `${COOKIE_NAME}=${encoded}; path=/; max-age=${COOKIE_MAX_AGE_S}; SameSite=Strict`;
  } catch { /* best-effort */ }
}

function cookieLoad(): SavedSession | null {
  try {
    const match = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (!match) return null;
    const json = decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
    const parsed = JSON.parse(json);
    return isSavedSession(parsed) ? parsed : null;
  } catch { return null; }
}

function cookieClear(): void {
  try {
    document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Strict`;
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// IndexedDB helpers (plain JSON, no encryption)
// ---------------------------------------------------------------------------

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function reqResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function idbSave(saved: SavedSession): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(JSON.parse(JSON.stringify(saved)), LAST_SESSION_ID);
    await txComplete(tx);
  } finally {
    db.close();
  }
}

async function idbLoad(): Promise<SavedSession | null> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const raw = await reqResult(tx.objectStore(STORE_NAME).get(LAST_SESSION_ID));
    await txComplete(tx);
    return isSavedSession(raw) ? raw : null;
  } finally {
    db.close();
  }
}

async function idbClear(): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(LAST_SESSION_ID);
    await txComplete(tx);
  } finally {
    db.close();
  }
}

// Also delete the old encrypted DB so it doesn't confuse future reads.
function deleteOldEncryptedDB(): void {
  try {
    if (hasIndexedDB()) indexedDB.deleteDatabase('airloom-secure-store');
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// localStorage helpers (fallback)
// ---------------------------------------------------------------------------

function lsSave(saved: SavedSession): void {
  try { localStorage.setItem(LS_SESSION_KEY, JSON.stringify(saved)); } catch { /* quota */ }
}

function lsLoad(): SavedSession | null {
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isSavedSession(parsed) ? parsed : null;
  } catch { return null; }
}

function lsClear(): void {
  try { localStorage.removeItem(LS_SESSION_KEY); } catch {}
}

// ---------------------------------------------------------------------------
// Legacy migration (airloom:lastSession → new store)
// ---------------------------------------------------------------------------

function readLegacy(): SavedSession | null {
  try {
    const raw = localStorage.getItem(LEGACY_LAST_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isSavedSession(parsed) ? parsed : null;
  } catch { return null; }
}

function clearLegacy(): void {
  try { localStorage.removeItem(LEGACY_LAST_SESSION_KEY); } catch {}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function requestPersistentStorage(): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch {}
}

export async function saveSavedSession(saved: SavedSession): Promise<void> {
  // Cookie first — this is the most reliable bridge between Safari and
  // standalone web app contexts on iOS.
  cookieSave(saved);
  // localStorage as a fast synchronous fallback
  lsSave(saved);
  // IndexedDB as the primary structured store
  if (hasIndexedDB()) {
    try { await idbSave(saved); } catch { /* cookie + localStorage already have it */ }
  }
  clearLegacy();
  deleteOldEncryptedDB();
  await requestPersistentStorage();
}

export async function loadSavedSession(): Promise<SavedSession | null> {
  // Migrate legacy localStorage entry first
  const legacy = readLegacy();
  if (legacy) {
    await saveSavedSession(legacy);
    return legacy;
  }
  // Try cookie first (bridges Safari ↔ standalone web app on iOS)
  const fromCookie = cookieLoad();
  if (fromCookie) return fromCookie;
  // Try IndexedDB
  if (hasIndexedDB()) {
    try {
      const session = await idbLoad();
      if (session) return session;
    } catch { /* fall through */ }
  }
  // Fall back to localStorage
  return lsLoad();
}

export async function clearSavedSession(): Promise<void> {
  clearLegacy();
  cookieClear();
  lsClear();
  if (hasIndexedDB()) {
    try { await idbClear(); } catch { /* best-effort */ }
  }
}
