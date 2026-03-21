import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type IPty, spawn } from 'node-pty';
import type { Channel, WriteStream } from '@airloom/channel';
import type {
  TerminalCloseMessage,
  TerminalExitMessage,
  TerminalInputMessage,
  TerminalMessage,
  TerminalOpenMessage,
  TerminalResizeMessage,
  TerminalStreamMeta,
} from '@airloom/protocol';

/**
 * node-pty ships a native `spawn-helper` binary in prebuilds/.
 * npm/npx often strips the execute bit from files in tarballs, which causes
 * posix_spawnp to fail at runtime. This function detects and fixes the
 * permission before we attempt to spawn a PTY.
 */
function fixSpawnHelperPermissions(): void {
  try {
    const require_ = createRequire(import.meta.url);
    const ptyDir = dirname(require_.resolve('node-pty/package.json'));
    const helperPath = join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (!existsSync(helperPath)) return;
    const mode = statSync(helperPath).mode;
    if (!(mode & 0o111)) {
      chmodSync(helperPath, mode | 0o755);
      console.log(`[host] Fixed spawn-helper permissions: ${helperPath}`);
    }
  } catch {
    // Non-fatal: if we can't fix permissions, the spawn will fail and we'll
    // see the existing error handling / fallback logic.
  }
}

// Fix permissions once at module load, before any PTY spawn attempt
fixSpawnHelperPermissions();

function resolveExecutable(command: string, envPath = process.env.PATH ?? ''): string | null {
  if (!command) return null;
  if (isAbsolute(command) && existsSync(command)) return command;
  if (command.includes('/')) {
    const candidate = resolve(process.cwd(), command);
    return existsSync(candidate) ? candidate : null;
  }
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'), command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseCommand(command: string): { file: string; args: string[] } {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command];
  return {
    file: parts[0],
    args: parts.slice(1).map((part) => part.replace(/^"|"$/g, '')),
  };
}

function getDefaultTerminalCommand(explicitCommand?: string): { file: string; args: string[] } {
  const configured = explicitCommand?.trim() || process.env.AIRLOOM_TERMINAL_COMMAND?.trim();
  if (configured) return parseCommand(configured);
  if (process.platform === 'win32') {
    const file = process.env.COMSPEC || 'powershell.exe';
    return { file, args: [] };
  }
  const shell = process.env.SHELL || '/bin/bash';
  const name = basename(shell);
  if (name === 'bash' || name === 'zsh' || name === 'sh') return { file: shell, args: ['-il'] };
  return { file: shell, args: ['-i'] };
}

class AdaptiveOutputBatcher {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastInputAt = 0;

  constructor(
    private onFlush: (data: string) => void,
    private readonly fastInterval = 16,
    private readonly slowInterval = 80,
    private readonly interactiveWindow = 250,
    private readonly maxBytes = 4096,
  ) {}

  noteInput(): void {
    this.lastInputAt = Date.now();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer) this.schedule();
  }

  write(data: string): void {
    this.buffer += data;
    if (this.buffer.length >= this.maxBytes) {
      this.flush();
      return;
    }
    this.schedule();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer) return;
    const data = this.buffer;
    this.buffer = '';
    this.onFlush(data);
  }

  destroy(): void {
    this.flush();
  }

  private schedule(): void {
    if (this.timer) return;
    const recentInput = Date.now() - this.lastInputAt <= this.interactiveWindow;
    this.timer = setTimeout(() => this.flush(), recentInput ? this.fastInterval : this.slowInterval);
  }
}

export function getTerminalLaunchDisplay(explicitCommand?: string): string {
  const command = getDefaultTerminalCommand(explicitCommand);
  return [command.file, ...command.args].join(' ');
}

const MAX_BUFFER_BYTES = 512 * 1024; // 512 KB scrollback

export class TerminalSession {
  private pty: IPty | null = null;
  private stream: WriteStream | null = null;
  private batcher: AdaptiveOutputBatcher | null = null;
  private cols = 120;
  private rows = 36;
  private outputBuffer = '';

  constructor(
    private readonly channel: Channel,
    private readonly getLaunchCommand?: () => string | undefined,
    private readonly broadcastFn?: (data: unknown) => void,
  ) {
    this.start();
  }

  private start(): void {
    const command = getDefaultTerminalCommand(this.getLaunchCommand?.());
    const file = resolveExecutable(command.file) ?? command.file;
    const cwd = process.cwd();
    console.log(`[host] PTY spawn: ${file} ${command.args.join(' ')} (${this.cols}x${this.rows}) node=${process.version}`);

    const env = { ...process.env as Record<string, string>, TERM: 'xterm-256color' };
    const spawnOpts = { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd, env };
    try {
      this.pty = spawn(file, command.args, spawnOpts);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      console.error(`[host] PTY spawn failed: ${e.message} (code=${e.code ?? 'none'}) file=${file} cwd=${cwd}`);
      // Fallback: try /bin/sh with no flags if the preferred shell failed
      if (file !== '/bin/sh') {
        console.error('[host] Retrying with /bin/sh...');
        try {
          this.pty = spawn('/bin/sh', [], spawnOpts);
          console.log('[host] PTY fallback to /bin/sh succeeded');
        } catch (err2) {
          console.error('[host] PTY fallback also failed:', (err2 as Error).message);
          return;
        }
      } else {
        return;
      }
    }

    this.pty.onData((data) => {
      process.stdout.write(data);
      // Append to scrollback buffer, trim oldest data if over limit
      this.outputBuffer += data;
      if (this.outputBuffer.length > MAX_BUFFER_BYTES) {
        this.outputBuffer = this.outputBuffer.slice(this.outputBuffer.length - MAX_BUFFER_BYTES);
      }
      this.batcher?.write(data);
      this.broadcastFn?.({ type: 'terminal_output', data });
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.batcher?.flush();
      this.detachStream();
      this.channel.send({ type: 'terminal_exit', exitCode, signal } satisfies TerminalExitMessage);
      this.pty = null;
    });
  }

  handleMessage(message: TerminalMessage): void {
    switch (message.type) {
      case 'terminal_open':
        this.attach(message);
        break;
      case 'terminal_input':
        this.writeInput(message);
        break;
      case 'terminal_resize':
        this.resize(message);
        break;
      case 'terminal_close':
        this.detachStream();
        break;
      case 'terminal_exit':
        break;
    }
  }

  private attach(message: TerminalOpenMessage): void {
    this.cols = Math.max(20, Math.floor(message.cols || this.cols));
    this.rows = Math.max(5, Math.floor(message.rows || this.rows));

    // Resize PTY to match new viewer dimensions
    this.pty?.resize(this.cols, this.rows);

    // Close any existing stream for a previous connection
    this.detachStream();

    // Open a new stream for the connecting viewer
    const meta: TerminalStreamMeta = { kind: 'terminal', cols: this.cols, rows: this.rows };
    this.stream = this.channel.createStream(meta as unknown as Record<string, unknown>);
    this.batcher = new AdaptiveOutputBatcher((data) => { this.stream?.write(data); });

    // Replay scrollback so the viewer sees existing terminal content immediately
    if (this.outputBuffer) {
      this.stream.write(this.outputBuffer);
    }

    // If PTY exited since last connection, restart it
    if (!this.pty) {
      this.start();
    }
  }

  /** End the current stream without killing the PTY (called on peer disconnect). */
  detachStream(): void {
    this.batcher?.destroy();
    this.batcher = null;
    if (this.stream && !this.stream.ended) this.stream.end();
    this.stream = null;
  }

  /** Kill the PTY — called only on host shutdown. */
  destroy(): void {
    this.detachStream();
    try { this.pty?.kill(); } catch {}
    this.pty = null;
    this.outputBuffer = '';
  }

  private writeInput(message: TerminalInputMessage): void {
    if (!this.pty) return;
    this.batcher?.noteInput();
    this.pty.write(message.data);
  }

  writeRawInput(data: string): void {
    if (!this.pty) return;
    this.batcher?.noteInput();
    this.pty.write(data);
  }

  private resize(message: TerminalResizeMessage): void {
    this.cols = Math.max(20, Math.floor(message.cols || this.cols));
    this.rows = Math.max(5, Math.floor(message.rows || this.rows));
    this.pty?.resize(this.cols, this.rows);
  }
}

export function isTerminalMessage(data: unknown): data is TerminalMessage {
  if (!data || typeof data !== 'object' || !('type' in data)) return false;
  const type = (data as { type?: unknown }).type;
  return type === 'terminal_open'
    || type === 'terminal_input'
    || type === 'terminal_resize'
    || type === 'terminal_close'
    || type === 'terminal_exit';
}
