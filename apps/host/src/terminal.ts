import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
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
    console.log(`[terminal] Flushing ${data.length} chars to stream`);
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

export class TerminalSession {
  private pty: IPty | null = null;
  private stream: WriteStream | null = null;
  private batcher: AdaptiveOutputBatcher | null = null;
  private cols = 120;
  private rows = 36;

  constructor(
    private readonly channel: Channel,
    private readonly getLaunchCommand?: () => string | undefined,
    private readonly broadcastFn?: (data: unknown) => void,
  ) {}

  handleMessage(message: TerminalMessage): void {
    switch (message.type) {
      case 'terminal_open':
        this.open(message);
        break;
      case 'terminal_input':
        this.writeInput(message);
        break;
      case 'terminal_resize':
        this.resize(message);
        break;
      case 'terminal_close':
        this.close();
        break;
      case 'terminal_exit':
        break;
    }
  }

  close(): void {
    this.batcher?.destroy();
    this.batcher = null;
    if (this.stream && !this.stream.ended) this.stream.end();
    this.stream = null;
    try { this.pty?.kill(); } catch {}
    this.pty = null;
  }

  private open(message: TerminalOpenMessage): void {
    this.cols = Math.max(20, Math.floor(message.cols || this.cols));
    this.rows = Math.max(5, Math.floor(message.rows || this.rows));
    if (this.pty) {
      this.pty.resize(this.cols, this.rows);
      return;
    }

    const command = getDefaultTerminalCommand(this.getLaunchCommand?.());
    const file = resolveExecutable(command.file) ?? command.file;
    const meta: TerminalStreamMeta = { kind: 'terminal', cols: this.cols, rows: this.rows };
    this.stream = this.channel.createStream(meta as unknown as Record<string, unknown>);
    this.batcher = new AdaptiveOutputBatcher((data) => this.stream?.write(data));

    const env = { ...process.env as Record<string, string>, TERM: 'xterm-256color' };
    console.log(`[terminal] Spawning: ${file} ${command.args.join(' ')}`);
    this.pty = spawn(file, command.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: process.cwd(),
      env,
    });

    this.pty.onData((data) => {
      this.batcher?.write(data);
      this.broadcastFn?.({ type: 'terminal_output', data });
    });
    this.pty.onExit(({ exitCode, signal }) => {
      console.log(`[terminal] PTY exited: code=${exitCode}, signal=${signal}`);
      this.batcher?.flush();
      this.stream?.end();
      this.channel.send({ type: 'terminal_exit', exitCode, signal } satisfies TerminalExitMessage);
      this.stream = null;
      this.batcher = null;
      this.pty = null;
    });
  }

  private writeInput(message: TerminalInputMessage): void {
    if (!this.pty) {
      console.log(`[terminal] Input ignored - no PTY: ${JSON.stringify(message.data)}`);
      return;
    }
    this.batcher?.noteInput();
    console.log(`[terminal] Input: ${JSON.stringify(message.data)}`);
    this.pty.write(message.data);
  }

  writeRawInput(data: string): void {
    if (!this.pty) {
      console.log(`[terminal] Raw input ignored - no PTY: ${JSON.stringify(data)}`);
      return;
    }
    this.batcher?.noteInput();
    console.log(`[terminal] Raw input: ${JSON.stringify(data)}`);
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
