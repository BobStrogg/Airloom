// A relay adapter abstracts the transport layer (WebSocket, Ably, etc.)
export interface RelayAdapter {
  connect(sessionToken: string, role: 'host' | 'viewer'): Promise<void>;
  send(payload: string): void;
  onMessage(handler: (payload: string) => void): void;
  onPeerJoined(handler: () => void): void;
  onPeerLeft(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
  onDisconnect(handler: () => void): void;
  close(): void;
  readonly connected: boolean;
}
