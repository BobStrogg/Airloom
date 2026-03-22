import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const CONTROL_COOKIE_NAME = 'airloom_control';

export interface RequestLike {
  headers: IncomingHttpHeaders;
  query?: Record<string, unknown>;
  url?: string;
}

export class FixedWindowRateLimiter {
  private entries = new Map<string, { count: number; resetAt: number }>();

  allow(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  }
}

export function createControlToken(): string {
  return randomBytes(24).toString('base64url');
}

export function encodeControlUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('t', token);
  return url.toString();
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) continue;
    result[rawKey] = decodeURIComponent(rawValue.join('='));
  }
  return result;
}

function safeEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readQueryToken(req: RequestLike): string | null {
  if (req.query && typeof req.query.t === 'string') return req.query.t;
  if (!req.url || !req.headers.host) return null;
  try {
    return new URL(req.url, `http://${req.headers.host}`).searchParams.get('t');
  } catch {
    return null;
  }
}

export function readControlToken(req: RequestLike): string | null {
  const headerToken = req.headers['x-airloom-control'];
  if (typeof headerToken === 'string') return headerToken;
  const queryToken = readQueryToken(req);
  if (queryToken) return queryToken;
  return parseCookies(req.headers.cookie)[CONTROL_COOKIE_NAME] ?? null;
}

export function hasValidControlToken(req: RequestLike, expected: string): boolean {
  const token = readControlToken(req);
  return typeof token === 'string' && safeEqual(token, expected);
}

export function hasAllowedOrigin(headers: IncomingHttpHeaders, host: string): boolean {
  const origin = headers.origin;
  if (!origin) return true;
  return origin === `http://${host}` || origin === `https://${host}`;
}
