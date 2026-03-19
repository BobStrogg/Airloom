import { spawn } from 'node:child_process';
import type { AIAdapter } from './types.js';
import type { WriteStream } from '@airloom/channel';

/** A preset CLI tool configuration. Prompt is appended as the last argument. */
export interface CLIPreset {
  id: string;
  name: string;
  command: string;
  description: string;
}

export const CLI_PRESETS: CLIPreset[] = [
  {
    id: 'devin',
    name: 'Devin',
    command: 'devin --permission-mode dangerous -p --',
    description: 'Devin CLI in non-interactive print mode',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude -p --output-format text',
    description: 'Claude Code in print mode',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex exec --full-auto',
    description: 'OpenAI Codex CLI in non-interactive exec mode',
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider --yes --no-auto-commits --message',
    description: 'Aider in scripting mode (prompt via --message)',
  },
  {
    id: 'custom',
    name: 'Custom',
    command: '',
    description: 'Custom command — prompt appended as last argument',
  },
];

export class CLIAdapter implements AIAdapter {
  readonly name = 'cli';
  readonly model: string;
  private command: string;
  private args: string[];

  constructor(config: { command: string; model?: string }) {
    if (!config.command) throw new Error('Command is required for CLI adapter');
    const parts = config.command.split(' ');
    this.command = parts[0];
    this.args = parts.slice(1);
    this.model = config.model || config.command;
  }

  async streamResponse(
    messages: Array<{ role: string; content: string }>,
    stream: WriteStream,
  ): Promise<void> {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      stream.write('[No user message provided]');
      stream.end();
      return;
    }

    return new Promise<void>((resolve) => {
      // Append user message as a trailing argument (e.g. after `--` in `devin -p --`)
      const args = [...this.args, lastUserMsg.content];
      const proc = spawn(this.command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

      proc.stdin.end();

      proc.stdout.on('data', (data: Buffer) => stream.write(stripAnsi(data.toString())));
      proc.stderr.on('data', (data: Buffer) => stream.write(stripAnsi(data.toString())));
      proc.on('close', () => { stream.end(); resolve(); });
      proc.on('error', (err) => { stream.write(`[Error: ${err.message}]`); stream.end(); resolve(); });
    });
  }
}
