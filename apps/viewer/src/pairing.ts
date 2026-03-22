export const DEFAULT_LOCAL_RELAY_URL = 'ws://localhost:4500';
export const INVALID_RELAY_URL_MESSAGE = 'Relay URL must start with ws:// or wss://';

export interface SavedSession {
  session: string;
  token?: string;
  transport: 'ws' | 'ably';
  relay: string;
  tokenExpiresAt?: number;
}

export interface PairSessionResponse {
  session: string;
  token?: string;
  transport: 'ws' | 'ably';
  relay: string;
  tokenExpiresAt?: number;
}

export type PairSessionFetcher = (input: string) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export type CodeConnectFallback =
  | { kind: 'saved-ably'; session: string; relay: string; token: string; tokenExpiresAt?: number }
  | { kind: 'manual-relay'; relay: string }
  | { kind: 'default-local-ws'; relay: string };

export type CodeConnectAttempt =
  | { kind: 'pair-session'; session: string; transport: 'ws' | 'ably'; relay: string; token?: string; tokenExpiresAt?: number }
  | CodeConnectFallback;

export interface CodeConnectPlan {
  attempts: CodeConnectAttempt[];
  relayInputError: string | null;
}

export function isLocalViewerHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function getRelayInputPlaceholder(hostname: string): string {
  return isLocalViewerHost(hostname)
    ? `WebSocket relay URL (default: ${DEFAULT_LOCAL_RELAY_URL})`
    : 'WebSocket relay URL (optional for self-hosted relay)';
}

export function isWebSocketRelayUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

export function normalizeStoredRelay(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return isWebSocketRelayUrl(trimmed) ? trimmed : null;
}

export function getNextStoredRelay(currentStoredRelay: string | null, latestRelay: string): string | null {
  return normalizeStoredRelay(latestRelay) ?? normalizeStoredRelay(currentStoredRelay);
}

function isPairSessionResponse(value: unknown): value is PairSessionResponse {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (data.transport !== 'ws' && data.transport !== 'ably') return false;
  if (typeof data.relay !== 'string') return false;
  if (typeof data.session !== 'string') return false;
  if (data.token !== undefined && typeof data.token !== 'string') return false;
  if (data.tokenExpiresAt !== undefined && typeof data.tokenExpiresAt !== 'number') return false;
  if (data.transport === 'ably' && typeof data.token !== 'string') return false;
  return true;
}

export function canAutoReconnectSavedSession(saved: SavedSession | null, now = Date.now()): saved is SavedSession {
  if (!saved) return false;
  if (saved.transport !== 'ably') return true;
  if (!saved.token) return false;
  return saved.tokenExpiresAt === undefined || saved.tokenExpiresAt > now + 30_000;
}

export async function fetchPairingSession(
  fetchImpl: PairSessionFetcher,
  origin: string,
  sessionToken: string,
): Promise<PairSessionResponse | null> {
  try {
    const res = await fetchImpl(`${origin}/api/pair?session=${encodeURIComponent(sessionToken)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return isPairSessionResponse(data) ? data : null;
  } catch {
    return null;
  }
}

function getRelayInputState(relayInputValue: string): {
  relay: string | null;
  error: string | null;
} {
  const relay = relayInputValue.trim();
  if (!relay) {
    return { relay: null, error: null };
  }
  if (!isWebSocketRelayUrl(relay)) {
    return { relay: null, error: INVALID_RELAY_URL_MESSAGE };
  }
  return { relay, error: null };
}

export function getCodeConnectFallbacks(opts: {
  saved: SavedSession | null;
  relayInputValue: string;
  viewerHostname: string;
}): CodeConnectFallback[] {
  const fallbacks: CodeConnectFallback[] = [];
  const relayInput = getRelayInputState(opts.relayInputValue);
  if (relayInput.relay) {
    fallbacks.push({ kind: 'manual-relay', relay: relayInput.relay });
  } else if (!relayInput.error && isLocalViewerHost(opts.viewerHostname)) {
    fallbacks.push({ kind: 'default-local-ws', relay: DEFAULT_LOCAL_RELAY_URL });
  }

  if (canAutoReconnectSavedSession(opts.saved) && opts.saved.transport === 'ably') {
    fallbacks.push({
      kind: 'saved-ably',
      session: opts.saved.session,
      relay: opts.saved.relay,
      token: opts.saved.token!,
      tokenExpiresAt: opts.saved.tokenExpiresAt,
    });
  }

  return fallbacks;
}

export function buildCodeConnectPlan(opts: {
  pairSession: PairSessionResponse | null;
  saved: SavedSession | null;
  relayInputValue: string;
  viewerHostname: string;
}): CodeConnectPlan {
  const relayInput = getRelayInputState(opts.relayInputValue);
  const attempts: CodeConnectAttempt[] = [];

  if (opts.pairSession) {
    attempts.push({ kind: 'pair-session', ...opts.pairSession });
  }

  attempts.push(
    ...getCodeConnectFallbacks({
      saved: opts.saved,
      relayInputValue: relayInput.relay ?? opts.relayInputValue,
      viewerHostname: opts.viewerHostname,
    }),
  );

  return {
    attempts,
    relayInputError: relayInput.error,
  };
}

export function selectCodeConnectFallback(opts: {
  saved: SavedSession | null;
  relayInputValue: string;
  viewerHostname: string;
}): CodeConnectFallback | { kind: 'unavailable' } {
  return getCodeConnectFallbacks(opts)[0] ?? { kind: 'unavailable' };
}
