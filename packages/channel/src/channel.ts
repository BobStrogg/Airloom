import { EventEmitter } from 'events';
import type { RelayAdapter } from './adapters/types.js';
import type { ChannelMessage } from '@airloom/protocol';
import { toBase64, fromBase64, encodeChannelMessage, decodeChannelMessage } from '@airloom/protocol';
import { encrypt, decrypt } from '@airloom/crypto';
import { WriteStream, ReadStream } from './stream.js';

export interface ChannelOptions {
  adapter: RelayAdapter;
  role: 'host' | 'viewer';
  encryptionKey?: Uint8Array;
}

export class Channel extends EventEmitter {
  private adapter: RelayAdapter;
  private encryptionKey: Uint8Array | null;
  private role: 'host' | 'viewer';
  private streams = new Map<string, ReadStream>();
  private _ready = false;
  private msgCounter = 0;

  constructor(opts: ChannelOptions) {
    super();
    this.adapter = opts.adapter;
    this.encryptionKey = opts.encryptionKey ?? null;
    this.role = opts.role;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.adapter.onMessage((payload: string) => {
      this.handlePayload(payload);
    });

    this.adapter.onPeerJoined(() => {
      if (this.encryptionKey) {
        this._ready = true;
        this.emit('ready');
      }
    });

    this.adapter.onPeerLeft(() => {
      this._ready = false;
      this.emit('peer_left');
    });

    this.adapter.onError((err) => this.emit('error', err));
    this.adapter.onDisconnect(() => this.emit('disconnect'));
  }

  private handlePayload(base64Payload: string): void {
    try {
      if (!this.encryptionKey) {
        this.emit('error', new Error('Received data but no encryption key'));
        return;
      }
      const sealed = fromBase64(base64Payload);
      const plaintext = decrypt(sealed, this.encryptionKey);
      const msg = decodeChannelMessage(plaintext);
      this.handleMessage(msg);
    } catch (err) {
      this.emit('error', err);
    }
  }

  private handleMessage(msg: ChannelMessage): void {
    switch (msg.type) {
      case 'message':
        this.emit('message', msg.data);
        break;
      case 'stream_start': {
        const stream = new ReadStream(msg.id, msg.meta);
        this.streams.set(msg.id, stream);
        this.emit('stream', stream);
        break;
      }
      case 'stream_chunk': {
        const stream = this.streams.get(msg.id);
        if (stream) stream._pushChunk(msg.data);
        break;
      }
      case 'stream_end': {
        const stream = this.streams.get(msg.id);
        if (stream) {
          stream._end();
          this.streams.delete(msg.id);
        }
        break;
      }
    }
  }

  private sendRaw(msg: ChannelMessage): void {
    if (!this.encryptionKey) throw new Error('No encryption key established');
    const plaintext = encodeChannelMessage(msg);
    const sealed = encrypt(plaintext, this.encryptionKey);
    this.adapter.send(toBase64(sealed));
  }

  send(data: unknown): void {
    const id = `msg-${++this.msgCounter}`;
    this.sendRaw({ type: 'message', id, data });
  }

  createStream(meta?: Record<string, unknown>): WriteStream {
    const id = `stream-${++this.msgCounter}`;
    this.sendRaw({ type: 'stream_start', id, meta });
    return new WriteStream(id, (msg) => this.sendRaw(msg), meta);
  }

  async connect(sessionToken: string): Promise<void> {
    await this.adapter.connect(sessionToken, this.role);
  }

  get ready(): boolean { return this._ready; }

  waitForReady(timeoutMs = 30000): Promise<void> {
    if (this._ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('ready', onReady);
        this.removeListener('error', onError);
        this.removeListener('disconnect', onDisconnect);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onError = (err: Error) => { cleanup(); reject(err); };
      const onDisconnect = () => { cleanup(); reject(new Error('Disconnected before ready')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for peer')); }, timeoutMs);
      this.once('ready', onReady);
      this.once('error', onError);
      this.once('disconnect', onDisconnect);
    });
  }

  close(): void {
    for (const stream of this.streams.values()) stream._end();
    this.streams.clear();
    this.adapter.close();
    this.removeAllListeners();
  }
}
