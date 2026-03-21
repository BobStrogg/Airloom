import { Channel, WebSocketAdapter, AblyAdapter, type ReadStream } from '@airloom/channel';
import type { RelayAdapter } from '@airloom/channel';
import { deriveSessionToken, deriveEncryptionKey, parsePairingCode } from '@airloom/crypto';
import { decodePairingData, type TerminalExitMessage, type TerminalMessage, type TerminalStreamMeta } from '@airloom/protocol';
import { sha256 } from '@noble/hashes/sha256';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const debugPanel = document.getElementById('debugPanel')!;
function debug(msg: string) {
  const line = document.createElement('div');
  line.textContent = `${Date.now().toString().slice(-4)}: ${msg}`;
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
  console.log(msg);
}

debug('Viewer starting...');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => (reg.active ? Promise.resolve() : new Promise<void>((r) => {
      const sw = reg.installing ?? reg.waiting;
      if (sw) sw.addEventListener('statechange', () => { if (sw.state === 'activated') r(); });
      else r();
    })).then(async () => {
      const cache = await caches.open('airloom-v2');
      const pageUrl = location.href.split('#')[0];
      const pageHit = await cache.match(pageUrl);
      if (!pageHit) await cache.add(pageUrl).catch(() => {});
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const urls = entries
        .map((e) => e.name)
        .filter((u) => { try { return new URL(u).origin === location.origin; } catch { return false; } });
      await Promise.all(urls.map((u) => cache.match(u).then((hit) => { if (!hit) return cache.add(u).catch(() => {}); })));
    }))
    .catch(() => {});
}

const connectScreen = document.getElementById('connectScreen')!;
const terminalScreen = document.getElementById('terminalScreen')!;
const scanBtn = document.getElementById('scanBtn')!;
const joinBtn = document.getElementById('joinBtn')!;
const codeInput = document.getElementById('codeInput') as HTMLInputElement;
const relayInput = document.getElementById('relayInput') as HTMLInputElement;
const connectError = document.getElementById('connectError')!;
const connectStatus = document.getElementById('connectStatus')!;
const disconnectBtn = document.getElementById('disconnectBtn')!;
const terminalStatus = document.getElementById('terminalStatus')!;
const qrReaderEl = document.getElementById('qrReader')!;
const terminalContainer = document.getElementById('terminalContainer')!;
const terminalEl = document.getElementById('terminal')!;
const focusTerminalBtn = document.getElementById('focusTerminalBtn')!;
const ctrlCBtn = document.getElementById('ctrlCBtn')!;
const escBtn = document.getElementById('escBtn')!;
const tabBtn = document.getElementById('tabBtn')!;

let channel: Channel | null = null;
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let terminalReady = false;

function saveConnectionParams(code: string | null, relayUrl: string) {
  try {
    if (code) localStorage.setItem('airloom:lastCode', code);
    localStorage.setItem('airloom:lastRelay', relayUrl);
  } catch {}
}

function restoreConnectionParams() {
  try {
    const code = localStorage.getItem('airloom:lastCode');
    const relay = localStorage.getItem('airloom:lastRelay');
    if (code && !codeInput.value) codeInput.value = code;
    if (relay && !relayInput.value) relayInput.value = relay;
  } catch {}
}

function ensureTerminal() {
  if (term) return;
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 14,
    lineHeight: 1.25,
    allowTransparency: true,
    scrollback: 5000,
    theme: {
      background: '#05070c',
      foreground: '#e6edf3',
      cursor: '#7c8aff',
      cursorAccent: '#05070c',
      selectionBackground: 'rgba(124,138,255,0.28)',
      black: '#0a0d14',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#7c8aff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#c9d1d9',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#a5b4ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    },
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalEl);
  term.onData((data) => {
    console.log(`[viewer] Terminal input: ${JSON.stringify(data)} (ready=${terminalReady}, channel=${!!channel})`);
    if (!terminalReady || !channel) return;
    channel.send({ type: 'terminal_input', data } satisfies TerminalMessage);
  });
  terminalContainer.addEventListener('click', () => term?.focus());
  resizeObserver = new ResizeObserver(() => fitAndSyncTerminal());
  resizeObserver.observe(terminalContainer);
}

function fitAndSyncTerminal(openIfNeeded = false) {
  if (!term || !fitAddon) return;
  fitAddon.fit();
  if (!channel || !terminalReady) return;
  const message: TerminalMessage = openIfNeeded
    ? { type: 'terminal_open', cols: term.cols, rows: term.rows }
    : { type: 'terminal_resize', cols: term.cols, rows: term.rows };
  channel.send(message);
}

function setTerminalStatus(text: string, className = 'status-badge') {
  terminalStatus.textContent = text;
  terminalStatus.className = className;
}

function writeTerminalLine(text: string) {
  if (!term) return;
  term.writeln(text.replace(/\n/g, '\r\n'));
}

function resetConnectionUI() {
  terminalReady = false;
  channel?.close();
  channel = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  term?.dispose();
  term = null;
  fitAddon = null;
  terminalEl.innerHTML = '';
  terminalScreen.style.display = 'none';
  connectScreen.style.display = 'flex';
  restoreConnectionParams();
}

restoreConnectionParams();

codeInput.addEventListener('input', () => {
  let v = codeInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4, 8);
  codeInput.value = v;
});

joinBtn.addEventListener('click', () => connectWithCode());
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectWithCode(); });

scanBtn.addEventListener('click', async () => {
  try {
    const { Html5Qrcode } = await import('html5-qrcode');
    qrReaderEl.style.display = 'block';
    const scanner = new Html5Qrcode('qrReader');
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (text) => { await scanner.stop(); qrReaderEl.style.display = 'none'; connectWithQR(text); },
      () => {},
    );
  } catch {
    showError('Camera access denied or not available');
  }
});

focusTerminalBtn.addEventListener('click', () => term?.focus());
ctrlCBtn.addEventListener('click', () => {
  term?.focus();
  channel?.send({ type: 'terminal_input', data: '\x03' } satisfies TerminalMessage);
});
escBtn.addEventListener('click', () => {
  term?.focus();
  channel?.send({ type: 'terminal_input', data: '\x1b' } satisfies TerminalMessage);
});
tabBtn.addEventListener('click', () => {
  term?.focus();
  channel?.send({ type: 'terminal_input', data: '\t' } satisfies TerminalMessage);
});

disconnectBtn.addEventListener('click', () => {
  channel?.send({ type: 'terminal_close' } satisfies TerminalMessage);
  resetConnectionUI();
});

(async () => {
  const hash = location.hash.slice(1);
  if (!hash) return;
  try {
    const json = atob(hash.replace(/-/g, '+').replace(/_/g, '/'));
    await connectWithQR(json);
  } catch {}
})();

async function connectWithCode() {
  const raw = parsePairingCode(codeInput.value);
  if (raw.length !== 8) { showError('Code must be 8 characters'); return; }
  const relayUrl = relayInput.value.trim() || 'ws://localhost:4500';
  saveConnectionParams(codeInput.value, relayUrl);
  const sessionToken = deriveSessionToken(raw);
  const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + sessionToken));
  const encryptionKey = deriveEncryptionKey(keyMaterial);
  await doConnect(relayUrl, sessionToken, encryptionKey);
}

async function connectWithQR(qrText: string) {
  try {
    const data = decodePairingData(qrText);
    saveConnectionParams(null, data.relay);
    const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + data.session));
    const encryptionKey = deriveEncryptionKey(keyMaterial);
    const transport = data.transport ?? 'ws';
    await doConnect(data.relay, data.session, encryptionKey, transport, data.token);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showError('Invalid QR code: ' + message);
  }
}

function isTerminalStream(stream: ReadStream): boolean {
  const meta = stream.meta as Partial<TerminalStreamMeta> | undefined;
  return meta?.kind === 'terminal';
}

async function doConnect(relayUrl: string, sessionToken: string, encryptionKey: Uint8Array, transport: 'ws' | 'ably' = 'ws', token?: string) {
  showStatus('Connecting...');
  hideError();
  try {
    let adapter: RelayAdapter;
    if (transport === 'ably') {
      if (!token) { showError('Ably transport requires a token'); return; }
      adapter = new AblyAdapter({ token });
    } else {
      adapter = new WebSocketAdapter(relayUrl);
    }
    channel = new Channel({ adapter, role: 'viewer', encryptionKey });

    channel.on('ready', () => {
      terminalReady = true;
      connectScreen.style.display = 'none';
      terminalScreen.style.display = 'flex';
      setTerminalStatus('Connected');
      ensureTerminal();
      requestAnimationFrame(() => {
        fitAndSyncTerminal(true);
        term?.focus();
      });
    });
    channel.on('peer_left', () => {
      setTerminalStatus('Disconnected', 'status-badge disconnected');
      writeTerminalLine('');
      writeTerminalLine('[host disconnected]');
    });
    channel.on('message', (data: unknown) => {
      if (!data || typeof data !== 'object' || !('type' in data)) return;
      if ((data as TerminalExitMessage).type === 'terminal_exit') {
        const exit = data as TerminalExitMessage;
        const detail = typeof exit.exitCode === 'number' ? `exit ${exit.exitCode}` : 'terminated';
        writeTerminalLine('');
        writeTerminalLine(`[terminal ${detail}]`);
      }
    });
    channel.on('stream', (stream: ReadStream) => {
      if (!isTerminalStream(stream)) {
        console.log('[viewer] Non-terminal stream received, ignoring');
        return;
      }
      console.log('[viewer] Terminal stream received');
      ensureTerminal();
      stream.on('data', (chunk: string) => {
        console.log(`[viewer] Stream data: ${chunk.length} chars`);
        term?.write(chunk);
      });
      stream.on('end', () => {
        console.log('[viewer] Stream ended');
        writeTerminalLine('[session closed]');
      });
    });
    channel.on('error', (err: Error) => {
      console.error('Channel error:', err);
      writeTerminalLine(`[error: ${err.message}]`);
    });
    channel.on('disconnect', () => setTerminalStatus('Reconnecting…', 'status-badge reconnecting'));

    await channel.connect(sessionToken);
    showStatus('Connected to relay, waiting for host...');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showError('Connection failed: ' + message);
  }
}

function showError(msg: string) { connectError.textContent = msg; connectError.style.display = 'block'; }
function hideError() { connectError.style.display = 'none'; }
function showStatus(msg: string) { connectStatus.textContent = msg; connectStatus.style.display = 'block'; }
