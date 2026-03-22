import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const SESSIONS_DIR = join(homedir(), '.config', 'airloom', 'sessions');

export interface SessionInfo {
  pid: number;
  port: number;
  controlUrl: string;
  viewerUrl: string;
  pairingCode: string;
  cwd: string;
  startedAt: number;
  logFile: string;
}

function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(name: string): string {
  return join(SESSIONS_DIR, `${name}.json`);
}

function logFilePath(name: string): string {
  return join(SESSIONS_DIR, `${name}.log`);
}

function validateName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid session name "${name}". Use only letters, numbers, hyphens, and underscores.`);
  }
}

function readSession(name: string): SessionInfo | null {
  try {
    const raw = readFileSync(sessionPath(name), 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data.pid !== 'number') return null;
    return data as SessionInfo;
  } catch {
    return null;
  }
}

function writeSession(name: string, info: SessionInfo): void {
  ensureDir();
  writeFileSync(sessionPath(name), JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
}

function removeSession(name: string): void {
  try { unlinkSync(sessionPath(name)); } catch {}
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listAllSessions(): Array<{ name: string; info: SessionInfo }> {
  ensureDir();
  let files: string[];
  try {
    files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const results: Array<{ name: string; info: SessionInfo }> = [];
  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    const info = readSession(name);
    if (!info) continue;
    if (!isAlive(info.pid)) {
      removeSession(name);
      continue;
    }
    results.push({ name, info });
  }
  return results;
}

function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

export async function handleStart(name: string, hostArgs: string[]): Promise<void> {
  validateName(name);

  const existing = readSession(name);
  if (existing && isAlive(existing.pid)) {
    console.error(`Session "${name}" is already running (PID ${existing.pid}, port ${existing.port})`);
    console.error(`Host UI: ${existing.controlUrl}`);
    process.exit(1);
  }
  if (existing) removeSession(name);

  ensureDir();
  const logFile = logFilePath(name);
  const logFd = openSync(logFile, 'w');

  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1], ...hostArgs, '--_daemon'],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      cwd: process.cwd(),
      env: process.env,
    },
  );

  try {
    const info = await new Promise<SessionInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for daemon to start (30s). Check log: ${logFile}`));
      }, 30_000);

      child.on('message', (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        if (m.type === 'ready') {
          clearTimeout(timer);
          resolve({
            pid: child.pid!,
            port: m.port as number,
            controlUrl: m.controlUrl as string,
            viewerUrl: m.viewerUrl as string,
            pairingCode: m.pairingCode as string,
            cwd: process.cwd(),
            startedAt: Date.now(),
            logFile,
          });
        }
      });

      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Daemon exited with code ${code}. Check log: ${logFile}`));
      });
    });

    writeSession(name, info);
    child.disconnect();
    child.unref();
    closeSync(logFd);

    console.log(`\nAirloom session "${name}" started (PID ${info.pid})\n`);
    console.log(`Pairing Code: ${info.pairingCode}`);
    console.log(`Viewer URL:   ${info.viewerUrl}`);
    console.log(`Host UI:      ${info.controlUrl}`);
    console.log(`Log:          ${info.logFile}\n`);
  } catch (err) {
    closeSync(logFd);
    try { child.kill(); } catch {}
    throw err;
  }
}

export function handleStop(nameOrNull: string | null, all: boolean): void {
  if (all) {
    const sessions = listAllSessions();
    if (sessions.length === 0) {
      console.log('No running sessions.');
      return;
    }
    for (const { name, info } of sessions) {
      try { process.kill(info.pid, 'SIGTERM'); } catch {}
      removeSession(name);
      console.log(`Stopped "${name}" (PID ${info.pid})`);
    }
    return;
  }

  const target = nameOrNull || 'default';
  const info = readSession(target);
  if (!info) {
    console.error(`No session named "${target}" found.`);
    process.exit(1);
  }
  if (!isAlive(info.pid)) {
    removeSession(target);
    console.log(`Session "${target}" was not running (cleaned up stale entry).`);
    return;
  }
  try { process.kill(info.pid, 'SIGTERM'); } catch {}
  removeSession(target);
  console.log(`Stopped "${target}" (PID ${info.pid})`);
}

export function handleList(): void {
  const sessions = listAllSessions();
  if (sessions.length === 0) {
    console.log('No running sessions.');
    return;
  }

  console.log('NAME            PORT   PID      STARTED          CWD');
  for (const { name, info } of sessions) {
    const age = formatAge(Date.now() - info.startedAt);
    console.log(
      name.padEnd(16) +
      String(info.port).padEnd(7) +
      String(info.pid).padEnd(9) +
      age.padEnd(17) +
      info.cwd,
    );
  }
}
