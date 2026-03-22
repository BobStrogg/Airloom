import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.config', 'airloom');
const STATE_PATH = join(STATE_DIR, 'state.json');

interface PersistentState {
  ablySessionToken?: string;
}

function readState(): PersistentState {
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const data = JSON.parse(raw) as PersistentState;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeState(state: PersistentState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

export function loadOrCreateAblySessionToken(): string {
  const state = readState();
  if (isSessionToken(state.ablySessionToken)) return state.ablySessionToken;
  const ablySessionToken = randomBytes(16).toString('hex');
  state.ablySessionToken = ablySessionToken;
  writeState(state);
  return ablySessionToken;
}
