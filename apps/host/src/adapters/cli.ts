import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { IPty } from 'node-pty';
import type { AIAdapter } from './types.js';
import type { WriteStream } from '@airloom/channel';

export interface CLIPreset {
  id: string;
  name: string;
  command: string;
  description: string;
  mode: 'oneshot' | 'repl';
  silenceTimeout?: number;
}

export const CLI_PRESETS: CLIPreset[] = [
  {
    id: 'devin',
    name: 'Devin',
    command: 'devin',
    description: 'Devin CLI (persistent REPL session)',
    mode: 'repl',
    silenceTimeout: 8000,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    description: 'Claude Code (persistent REPL session)',
    mode: 'repl',
    silenceTimeout: 8000,
  },
  {
    id: 'claude-code-oneshot',
    name: 'Claude Code (one-shot)',
    command: 'claude -p --output-format text',
    description: 'Claude Code in print mode (new process per prompt)',
    mode: 'oneshot',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex exec --full-auto',
    description: 'OpenAI Codex CLI in non-interactive exec mode',
    mode: 'oneshot',
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider --yes --no-auto-commits --message',
    description: 'Aider in scripting mode (prompt via --message)',
    mode: 'oneshot',
  },
  {
    id: 'custom',
    name: 'Custom',
    command: '',
    description: 'Custom command (default: one-shot, prompt appended as last arg)',
    mode: 'oneshot',
  },
];

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]()#;?][^\x1b]?|\r/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

const isDecorativeLine = (line: string): boolean => {
  const t = line.trim();
  if (!t) return false;
  return /^[╭╰╮╯│├┤┬┴┼─━═┄┈┌┐└┘║╔╗╚╝╠╣╦╩╬▔▁░▒▓█\-+|=*~_\s]+$/.test(t);
};

const isNoiseLine = (line: string): boolean => {
  const t = line.trim();
  if (!t) return false;
  return t === '#'
    || t.includes('Devin for Terminal')
    || /^v\d{4}\./.test(t)
    || t.startsWith('Mode: ')
    || t.includes('Tip: Use shift+tab')
    || t.startsWith('Update v')
    || t.includes('∙ Pro');
};

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

export class CLIAdapter implements AIAdapter {
  readonly name = 'cli';
  readonly model: string;
  private command: string;
  private args: string[];
  private mode: 'oneshot' | 'repl';
  private silenceTimeout: number;
  private pty: IPty | null = null;
  private ptyState: 'starting' | 'idle' | 'responding' = 'starting';
  private startupResolve: (() => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private activeStream: WriteStream | null = null;
  private activeResolve: (() => void) | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInput = '';

  constructor(config: {
    command: string;
    model?: string;
    mode?: 'oneshot' | 'repl';
    silenceTimeout?: number;
  }) {
    if (!config.command) throw new Error('Command is required for CLI adapter');
    const parts = config.command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [config.command];
    this.command = parts[0];
    this.args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ''));
    this.mode = config.mode ?? 'oneshot';
    this.silenceTimeout = config.silenceTimeout ?? 5000;
    this.model = config.model || `${config.command} (${this.mode})`;
  }

  async streamResponse(
    messages: Array<{ role: string; content: string }>,
    stream: WriteStream,
  ): Promise<void> {
    if (this.mode === 'repl') return this.replResponse(messages, stream);
    return this.oneshotResponse(messages, stream);
  }

  destroy(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    try { this.pty?.kill(); } catch {}
    this.pty = null;
    this.finishResponse();
  }

  // --- oneshot ----------------------------------------------------------------

  private async oneshotResponse(
    messages: Array<{ role: string; content: string }>,
    stream: WriteStream,
  ): Promise<void> {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) { stream.write('[No user message provided]'); stream.end(); return; }

    return new Promise<void>((resolvePromise) => {
      const args = [...this.args, lastUserMsg.content];
      const proc = spawn(this.command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      proc.stdin.end();
      proc.stdout.on('data', (data: Buffer) => stream.write(stripAnsi(data.toString())));
      proc.stderr.on('data', (data: Buffer) => stream.write(stripAnsi(data.toString())));
      proc.on('close', () => { stream.end(); resolvePromise(); });
      proc.on('error', (err) => { stream.write(`[Error: ${err.message}]`); stream.end(); resolvePromise(); });
    });
  }

  // --- repl -------------------------------------------------------------------

  private async ensurePty(): Promise<IPty> {
    if (this.pty) return this.pty;

    // Lazy-load node-pty so oneshot mode never requires it
    const nodePty = await import('node-pty');
    const executable = resolveExecutable(this.command) ?? this.command;
    console.log(`[cli-repl] Spawning PTY: ${executable} ${this.args.join(' ')}`);

    const pty = nodePty.spawn(executable, this.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: { ...process.env as Record<string, string>, NO_COLOR: '1' },
    });

    pty.onData((data) => this.onData(data));
    pty.onExit(({ exitCode }) => {
      console.log(`[cli-repl] PTY exited (code ${exitCode})`);
      this.pty = null;
      this.ptyState = 'idle';
      this.finishResponse();
    });

    this.pty = pty;
    this.ptyState = 'starting';

    // Wait for startup output to settle (silence for 2 s, max 5 s)
    await new Promise<void>((resolvePromise) => {
      this.startupResolve = resolvePromise;
      const maxTimer = setTimeout(() => {
        if (this.ptyState === 'starting') {
          this.ptyState = 'idle';
          this.startupResolve?.();
          this.startupResolve = null;
        }
        if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null; }
      }, 5000);
      pty.onExit(() => { clearTimeout(maxTimer); resolvePromise(); });
    });

    return pty;
  }

  private onData(raw: string): void {
    const clean = stripAnsi(raw);
    switch (this.ptyState) {
      case 'starting':
        // Reset the silence timer; it fires when startup output settles
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = setTimeout(() => {
          this.ptyState = 'idle';
          this.startupResolve?.();
          this.startupResolve = null;
        }, 2000);
        break;
      case 'idle':
        break;
      case 'responding': {
        if (!this.activeStream || !clean) break;
        const filtered = this.filterOutput(clean);
        if (filtered) this.activeStream.write(filtered);
        this.resetSilenceTimer();
        break;
      }
    }
  }

  private filterOutput(text: string): string {
    const lines = text.split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { kept.push(line); continue; }
      if (this.lastInput && (trimmed === this.lastInput.trim() || trimmed === `> ${this.lastInput.trim()}`)) continue;
      if (isDecorativeLine(line) || isNoiseLine(line)) continue;
      kept.push(line);
    }
    return kept.join('\n').replace(/^\n+/, '');
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.ptyState = 'idle';
      this.finishResponse();
    }, this.silenceTimeout);
  }

  private finishResponse(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    const stream = this.activeStream;
    const resolvePromise = this.activeResolve;
    this.activeStream = null;
    this.activeResolve = null;
    if (stream && !stream.ended) stream.end();
    resolvePromise?.();
  }

  private async replResponse(
    messages: Array<{ role: string; content: string }>,
    stream: WriteStream,
  ): Promise<void> {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) { stream.write('[No user message provided]'); stream.end(); return; }

    const pty = await this.ensurePty();

    return new Promise<void>((resolvePromise) => {
      this.activeStream = stream;
      this.activeResolve = resolvePromise;
      this.ptyState = 'responding';
      this.lastInput = lastUserMsg.content;
      pty.write(lastUserMsg.content + '\r');
      this.resetSilenceTimer();
    });
  }
}
