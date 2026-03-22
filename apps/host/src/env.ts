import { isIP } from 'node:net';

const DEFAULT_ABLY_KEY = 'SfHSAQ.IRTOQQ:FBbi9a7ZV6jIu0Gdo_UeYhIN4rzpMrud5-LldURNh9s';
const DEFAULT_VIEWER_URL = 'https://bobstrogg.github.io/Airloom/';
const DEFAULT_ABLY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOST_BIND = '127.0.0.1';
const DEFAULT_HOST_PORT = 4000;

export interface HostEnvConfig {
  viewerUrl: string;
  relayUrl?: string;
  ablyApiKey?: string;
  ablyTokenTtlMs: number;
  hostPort: number;
  hostBind: string;
  useAbly: boolean;
  isDefaultAblyKey: boolean;
}

function parseInteger(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseViewerUrl(value: string | undefined): string {
  const candidate = value?.trim() || DEFAULT_VIEWER_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('VIEWER_URL must be a valid http:// or https:// URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('VIEWER_URL must use http:// or https://');
  }
  return parsed.toString();
}

function parseRelayUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('RELAY_URL must be a valid ws:// or wss:// URL');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('RELAY_URL must use ws:// or wss://');
  }
  return parsed.toString();
}

function parseHostBind(value: string | undefined, isDev: boolean): string {
  const bind = value?.trim() || (isDev ? '0.0.0.0' : DEFAULT_HOST_BIND);
  if (bind === 'localhost' || isIP(bind) !== 0) return bind;
  if (/^[A-Za-z0-9.-]+$/.test(bind)) return bind;
  throw new Error('HOST_BIND must be localhost, an IP address, or a hostname');
}

export function isLoopbackBind(bind: string): boolean {
  return bind === '127.0.0.1' || bind === '::1' || bind === 'localhost';
}

export function parseHostEnv(cliPort?: number, isDev = false): HostEnvConfig {
  const relayUrl = parseRelayUrl(process.env.RELAY_URL);
  const ablyApiKey = process.env.ABLY_API_KEY ?? (relayUrl ? undefined : DEFAULT_ABLY_KEY);
  const ablyTokenTtlMs = parseInteger('ABLY_TOKEN_TTL', process.env.ABLY_TOKEN_TTL, DEFAULT_ABLY_TOKEN_TTL_MS, 60_000, 31 * 24 * 60 * 60 * 1000);
  const hostPort = cliPort ?? parseInteger('HOST_PORT', process.env.HOST_PORT, DEFAULT_HOST_PORT, 0, 65_535);
  const hostBind = parseHostBind(process.env.HOST_BIND, isDev);
  const viewerUrl = parseViewerUrl(process.env.VIEWER_URL);
  return {
    viewerUrl,
    relayUrl,
    ablyApiKey,
    ablyTokenTtlMs,
    hostPort,
    hostBind,
    useAbly: !!ablyApiKey,
    isDefaultAblyKey: !!ablyApiKey && ablyApiKey === DEFAULT_ABLY_KEY,
  };
}
