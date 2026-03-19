import type { RelayAdapter } from './types.js';

type MessageHandler = (payload: string) => void;
type VoidHandler = () => void;
type ErrorHandler = (err: Error) => void;

export class WebSocketAdapter implements RelayAdapter {
  private ws: WebSocket | null = null;
  private url: string;
  private _connected = false;
  private messageHandlers: MessageHandler[] = [];
  private peerJoinedHandlers: VoidHandler[] = [];
  private peerLeftHandlers: VoidHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private disconnectHandlers: VoidHandler[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private sessionToken: string | null = null;
  private role: 'host' | 'viewer' | null = null;

  constructor(url: string) {
    this.url = url;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(sessionToken: string, role: 'host' | 'viewer'): Promise<void> {
    this.sessionToken = sessionToken;
    this.role = role;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    const ws = await this.createWebSocket(this.url);
    return new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this._connected = true;
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        // Send create or join message
        const msg = this.role === 'host'
          ? { type: 'create', sessionToken: this.sessionToken }
          : { type: 'join', sessionToken: this.sessionToken };
        ws.send(JSON.stringify(msg));
        resolve();
      };

      ws.onmessage = (event: MessageEvent | { data: unknown }) => {
        const raw = event.data;
        const data = typeof raw === 'string'
          ? raw
          : (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw))
            ? (raw as Buffer).toString('utf-8')
            : new TextDecoder().decode(raw as ArrayBuffer);
        try {
          const msg = JSON.parse(data);
          switch (msg.type) {
            case 'created':
            case 'joined':
              // Session confirmed
              break;
            case 'peer_joined':
              this.peerJoinedHandlers.forEach((h) => h());
              break;
            case 'peer_left':
              this.peerLeftHandlers.forEach((h) => h());
              break;
            case 'forward':
              this.messageHandlers.forEach((h) => h(msg.payload));
              break;
            case 'error':
              this.errorHandlers.forEach((h) => h(new Error(msg.message)));
              break;
          }
        } catch (err) {
          this.errorHandlers.forEach((h) => h(err instanceof Error ? err : new Error(String(err))));
        }
      };

      ws.onclose = () => {
        const wasConnected = this._connected;
        this._connected = false;
        if (wasConnected) {
          this.disconnectHandlers.forEach((h) => h());
        }
        if (this.shouldReconnect && !this.reconnectTimer) this.attemptReconnect();
      };

      ws.onerror = (err: Event | Error) => {
        const error = err instanceof Error ? err : new Error('WebSocket error');
        this.errorHandlers.forEach((h) => h(error));
        if (!this._connected) {
          this.shouldReconnect = false; // prevent onclose from reconnecting on initial failure
          reject(error);
        }
      };

      this.ws = ws;
    });
  }

  private async createWebSocket(url: string): Promise<WebSocket> {
    // Browser: native WebSocket
    if (typeof globalThis.WebSocket !== 'undefined') {
      return new globalThis.WebSocket(url);
    }
    // Node.js: dynamic import ws package
    try {
      const { default: WS } = await import('ws');
      return new WS(url) as unknown as WebSocket;
    } catch {
      throw new Error('No WebSocket implementation available. Install the "ws" package for Node.js.');
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    if (!this.sessionToken || !this.role) return;

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {
        // Reconnect failed, will try again via onclose
      });
    }, delay);
  }

  send(payload: string): void {
    if (!this.ws || !this._connected) return;
    this.ws.send(JSON.stringify({ type: 'forward', payload }));
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
    this.shouldReconnect = false;
    this.maxReconnectAttempts = 0;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }
}
