import type WebSocket from 'ws';

export interface Session {
  id: string;
  token: string;
  host: WebSocket | null;
  viewer: WebSocket | null;
  createdAt: number;
  lastActivity: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(private sessionTtlMs = 4 * 60 * 60 * 1000) {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  create(token: string): Session {
    if (this.sessions.has(token)) {
      throw new Error('Session already exists');
    }
    const session: Session = {
      id: crypto.randomUUID(),
      token,
      host: null,
      viewer: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.sessions.set(token, session);
    return session;
  }

  get(token: string): Session | undefined {
    return this.sessions.get(token);
  }

  remove(token: string): void {
    this.sessions.delete(token);
  }

  touch(token: string): void {
    const session = this.sessions.get(token);
    if (session) session.lastActivity = Date.now();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now - session.lastActivity > this.sessionTtlMs) {
        session.host?.close();
        session.viewer?.close();
        this.sessions.delete(token);
      }
    }
  }

  get size(): number { return this.sessions.size; }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const session of this.sessions.values()) {
      session.host?.close();
      session.viewer?.close();
    }
    this.sessions.clear();
  }
}
