export class Batcher {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushFn: (data: string) => void;
  private interval: number;
  private maxBytes: number;
  private _destroyed = false;

  constructor(opts: {
    interval?: number;
    maxBytes?: number;
    onFlush: (data: string) => void;
  }) {
    this.interval = opts.interval ?? 500;
    this.maxBytes = opts.maxBytes ?? 4096;
    this.flushFn = opts.onFlush;
  }

  write(data: string): void {
    if (this._destroyed) return;
    this.buffer += data;
    if (this.buffer.length >= this.maxBytes) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.interval);
    }
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer) {
      const data = this.buffer;
      this.buffer = '';
      this.flushFn(data);
    }
  }

  destroy(): void {
    this._destroyed = true;
    this.flush();
  }
}
