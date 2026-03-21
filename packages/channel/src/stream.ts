import { EventEmitter } from 'events';
import type { ChannelMessage } from '@airloom/protocol';

export class WriteStream {
  private _ended = false;

  constructor(
    private id: string,
    private sendFn: (msg: ChannelMessage) => void,
    public readonly meta?: Record<string, unknown>,
  ) {}

  write(data: string): void {
    if (this._ended) throw new Error('Cannot write after stream has ended');
    console.log(`[WriteStream] Sending chunk: ${data.length} chars, id=${this.id}`);
    this.sendFn({ type: 'stream_chunk', id: this.id, data });
  }

  end(): void {
    if (this._ended) return;
    this._ended = true;
    this.sendFn({ type: 'stream_end', id: this.id });
  }

  get ended(): boolean { return this._ended; }
}

export class ReadStream extends EventEmitter {
  public readonly id: string;
  public readonly meta?: Record<string, unknown>;
  private _ended = false;

  constructor(id: string, meta?: Record<string, unknown>) {
    super();
    this.id = id;
    this.meta = meta;
  }

  /** @internal Called when a chunk arrives */
  _pushChunk(data: string): void {
    if (!this._ended) this.emit('data', data);
  }

  /** @internal Called when the stream ends */
  _end(): void {
    if (this._ended) return;
    this._ended = true;
    this.emit('end');
  }

  get ended(): boolean {
    return this._ended;
  }
}
