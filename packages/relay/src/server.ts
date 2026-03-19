import { WebSocketServer, type WebSocket } from 'ws';
import { SessionManager } from './session.js';
import { RateLimiter, DEFAULT_LIMITS, type RateLimitConfig } from './limits.js';

export interface RelayServerOptions {
  port: number;
  limits?: Partial<RateLimitConfig>;
}

const PING_INTERVAL = 30_000;

function safeSend(ws: WebSocket, data: string): void {
  if (ws.readyState === 1) ws.send(data);
}

export function createRelayServer(opts: RelayServerOptions) {
  const sessions = new SessionManager();
  const limiters = new Map<string, RateLimiter>();
  const maxPayload = opts.limits?.maxMessageSize ?? DEFAULT_LIMITS.maxMessageSize;
  const wss = new WebSocketServer({ port: opts.port, maxPayload });

  // Heartbeat: detect half-open connections
  const aliveSet = new WeakSet<WebSocket>();
  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!aliveSet.has(ws)) { ws.terminate(); continue; }
      aliveSet.delete(ws);
      ws.ping();
    }
  }, PING_INTERVAL);

  wss.on('connection', (ws: WebSocket) => {
    aliveSet.add(ws);
    ws.on('pong', () => aliveSet.add(ws));

    let sessionToken: string | null = null;
    let role: 'host' | 'viewer' | null = null;

    ws.on('message', (raw: Buffer | string) => {
      const data = raw.toString();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      switch (msg.type) {
        case 'create': {
          if (typeof msg.sessionToken !== 'string' || !msg.sessionToken) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid session token' }));
            return;
          }
          if (sessions.size >= (opts.limits?.maxSessionsTotal ?? DEFAULT_LIMITS.maxSessionsTotal)) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Server at capacity' }));
            return;
          }
          try {
            const session = sessions.create(msg.sessionToken);
            session.host = ws;
            sessionToken = msg.sessionToken;
            role = 'host';
            limiters.set(msg.sessionToken, new RateLimiter(opts.limits));
            safeSend(ws, JSON.stringify({ type: 'created', sessionId: session.id }));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            safeSend(ws, JSON.stringify({ type: 'error', message }));
          }
          break;
        }

        case 'join': {
          if (typeof msg.sessionToken !== 'string' || !msg.sessionToken) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid session token' }));
            return;
          }
          const session = sessions.get(msg.sessionToken);
          if (!session) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Session not found' }));
            return;
          }
          if (session.viewer) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Session already has a viewer' }));
            return;
          }
          session.viewer = ws;
          sessionToken = msg.sessionToken;
          role = 'viewer';
          safeSend(ws, JSON.stringify({ type: 'joined', sessionId: session.id }));
          if (session.host) safeSend(session.host, JSON.stringify({ type: 'peer_joined' }));
          safeSend(ws, JSON.stringify({ type: 'peer_joined' }));
          break;
        }

        case 'forward': {
          if (!sessionToken || !role) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Not in a session' }));
            return;
          }
          if (typeof msg.payload !== 'string') {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid payload' }));
            return;
          }
          const sizeBytes = Buffer.byteLength(data, 'utf8');
          const limiter = limiters.get(sessionToken);
          if (limiter && !limiter.checkMessage(sizeBytes)) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Rate limited' }));
            return;
          }
          const session = sessions.get(sessionToken);
          if (!session) return;
          sessions.touch(sessionToken);
          const peer = role === 'host' ? session.viewer : session.host;
          if (peer) safeSend(peer, JSON.stringify({ type: 'forward', payload: msg.payload }));
          break;
        }

        default:
          safeSend(ws, JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
          break;
      }
    });

    ws.on('close', () => {
      if (!sessionToken) return;
      const session = sessions.get(sessionToken);
      if (!session) return;
      if (role === 'host') {
        if (session.viewer) safeSend(session.viewer, JSON.stringify({ type: 'peer_left' }));
        sessions.remove(sessionToken);
        limiters.delete(sessionToken);
      } else if (role === 'viewer') {
        session.viewer = null;
        if (session.host) safeSend(session.host, JSON.stringify({ type: 'peer_left' }));
      }
    });

    ws.on('error', (err) => {
      console.error('[relay] WebSocket error:', err.message);
    });
  });

  console.log(`[relay] Listening on ws://localhost:${opts.port}`);

  return {
    wss,
    sessions,
    close() {
      clearInterval(pingInterval);
      sessions.destroy();
      limiters.clear();
      wss.close();
    },
  };
}
