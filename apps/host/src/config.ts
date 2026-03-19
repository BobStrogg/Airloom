import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'airloom');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** Persisted adapter configuration. API keys are NOT stored — use env vars. */
export interface SavedConfig {
  type: 'anthropic' | 'openai' | 'cli';
  model?: string;
  /** CLI preset id (e.g. 'devin', 'claude-code', 'custom') */
  preset?: string;
  /** Full CLI command string */
  command?: string;
}

export function loadConfig(): SavedConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw) as SavedConfig;
    if (!data.type) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveConfig(config: SavedConfig): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[config] Failed to save:', (err as Error).message);
  }
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
