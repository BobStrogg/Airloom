// Relay protocol message types (client <-> relay communication)
export type RelayMessage =
  | { type: 'create'; sessionToken: string }
  | { type: 'join'; sessionToken: string }
  | { type: 'created'; sessionId: string }
  | { type: 'joined'; sessionId: string }
  | { type: 'peer_joined' }
  | { type: 'peer_left' }
  | { type: 'forward'; payload: string } // base64-encoded encrypted data
  | { type: 'error'; message: string };

// Channel message types (peer <-> peer, encrypted)
export type ChannelMessage =
  | { type: 'message'; id: string; data: unknown }
  | { type: 'stream_start'; id: string; meta?: Record<string, unknown> }
  | { type: 'stream_chunk'; id: string; data: string }
  | { type: 'stream_end'; id: string };

// Pairing data embedded in QR code
export interface PairingData {
  relay: string;       // relay WebSocket URL or Ably identifier
  session: string;     // session token for relay lookup
  pub: string;         // base64-encoded X25519 public key
  v: number;           // protocol version
  transport?: 'ws' | 'ably'; // transport type (default: 'ws')
  token?: string;      // scoped Ably token for viewer auth (never the root key)
}

// Session info held by the host
export interface SessionInfo {
  sessionToken: string;
  pairingCode: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  encryptionKey?: Uint8Array;
}

// AI adapter message types
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AdapterConfig {
  type: 'anthropic' | 'openai' | 'cli';
  apiKey?: string;
  model?: string;
  command?: string; // for CLI adapter
}
