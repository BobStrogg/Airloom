import { Realtime } from 'ably';
import type { ClientOptions } from 'ably';
import type { RelayAdapter } from './types.js';

type MessageHandler = (payload: string) => void;
type VoidHandler = () => void;
type ErrorHandler = (err: Error) => void;

// Host uses { key } (root API key stays server-side)
// Viewer uses { token } (scoped, time-limited token from QR code)
export type AblyAdapterOptions =
  | { key: string; token?: never }
  | { token: string; key?: never };

export class AblyAdapter implements RelayAdapter {
  private ably: Realtime | null = null;
  private channel: ReturnType<Realtime['channels']['get']> | null = null;
  private opts: AblyAdapterOptions;
  private _connected = false;
  private clientId: string | null = null;
  private messageHandlers: MessageHandler[] = [];
  private peerJoinedHandlers: VoidHandler[] = [];
  private peerLeftHandlers: VoidHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private disconnectHandlers: VoidHandler[] = [];

  constructor(opts: AblyAdapterOptions) {
    if (!opts.key && !opts.token) throw new Error('Ably API key or token is required');
    this.opts = opts;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(sessionToken: string, role: 'host' | 'viewer'): Promise<void> {
    this.clientId = `airloom-${role}-${Date.now()}`;

    const clientOpts: ClientOptions = { 
      clientId: this.clientId,
      // Enable server time sync to avoid "Timestamp not current" errors on machines with clock skew
      queryTime: true 
    };
    if (this.opts.key) {
      clientOpts.key = this.opts.key;
    } else {
      clientOpts.token = this.opts.token;
    }

    this.ably = new Realtime(clientOpts);

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      this.ably!.connection.once('connected', () => resolve());
      this.ably!.connection.once('failed', (stateChange) => {
        reject(new Error(stateChange?.reason?.message ?? 'Ably connection failed'));
      });
    });

    this._connected = true;

    // Monitor connection state
    this.ably.connection.on('disconnected', () => {
      this._connected = false;
      this.disconnectHandlers.forEach((h) => h());
    });
    this.ably.connection.on('connected', () => {
      this._connected = true;
      // After reconnection, re-check if peer is still present so the UI
      // can transition back from "Disconnected" / "Reconnecting…" to "Connected".
      if (this.channel) {
        this.channel.presence.get().then((members) => {
          const hasPeer = members.some((m) => m.clientId !== this.clientId);
          if (hasPeer) this.peerJoinedHandlers.forEach((h) => h());
        }).catch(() => {});
      }
    });
    this.ably.connection.on('failed', (stateChange) => {
      this._connected = false;
      const err = new Error(stateChange?.reason?.message ?? 'Ably connection failed');
      this.errorHandlers.forEach((h) => h(err));
    });

    // Get channel for this session
    this.channel = this.ably.channels.get(`airloom:${sessionToken}`);

    // Subscribe to forwarded messages (ignore our own)
    this.channel.subscribe('forward', (msg) => {
      if (msg.clientId === this.clientId) return;
      if (typeof msg.data === 'string') {
        this.messageHandlers.forEach((h) => h(msg.data as string));
      }
    });

    // Subscribe to presence events
    this.channel.presence.subscribe('enter', (member) => {
      if (member.clientId !== this.clientId) {
        this.peerJoinedHandlers.forEach((h) => h());
      }
    });
    this.channel.presence.subscribe('leave', (member) => {
      if (member.clientId !== this.clientId) {
        this.peerLeftHandlers.forEach((h) => h());
      }
    });

    // Enter presence
    await this.channel.presence.enter({ role });

    // Check if peer is already present
    const members = await this.channel.presence.get();
    const hasPeer = members.some((m) => m.clientId !== this.clientId);
    if (hasPeer) {
      this.peerJoinedHandlers.forEach((h) => h());
    }
  }

  send(payload: string): void {
    if (!this.channel || !this._connected) return;
    this.channel.publish('forward', payload);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onPeerJoined(handler: VoidHandler): void {
    this.peerJoinedHandlers.push(handler);
  }

  onPeerLeft(handler: VoidHandler): void {
    this.peerLeftHandlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  onDisconnect(handler: VoidHandler): void {
    this.disconnectHandlers.push(handler);
  }

  close(): void {
    // presence.leave() and detach() return promises that may reject if already
    // disconnected — swallow those rejections so shutdown is always clean.
    this.channel?.presence.leave().catch(() => {});
    this.channel?.detach().catch(() => {});
    try { this.ably?.close(); } catch { /* ignore */ }
    this.channel = null;
    this.ably = null;
    this._connected = false;
  }
}
