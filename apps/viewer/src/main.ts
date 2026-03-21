import { Channel, WebSocketAdapter, AblyAdapter, type ReadStream } from '@airloom/channel';
import type { RelayAdapter } from '@airloom/channel';
import { deriveSessionToken, deriveEncryptionKey, parsePairingCode } from '@airloom/crypto';
import { decodePairingData, type TerminalExitMessage, type TerminalMessage, type TerminalStreamMeta } from '@airloom/protocol';
import { sha256 } from '@noble/hashes/sha256';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function debug(msg: string) {
  console.log(msg);
}

// Unregister any previously-installed service worker so stale cached
// versions of the viewer don't block updates.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) =>
    regs.forEach((r) => r.unregister()),
  );
  caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
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

interface SavedSession { session: string; token?: string; transport: 'ws' | 'ably'; relay: string; hostOrigin?: string; }

function saveConnectionParams(_code: string | null, relayUrl: string) {
  try {
    localStorage.setItem('airloom:lastRelay', relayUrl);
  } catch {}
}

function saveLastSession(s: SavedSession) {
  try { localStorage.setItem('airloom:lastSession', JSON.stringify(s)); } catch {}
}

function loadLastSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem('airloom:lastSession');
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch { return null; }
}

function clearLastSession() {
  try { localStorage.removeItem('airloom:lastSession'); } catch {}
}

function restoreConnectionParams() {
  try {
    const relay = localStorage.getItem('airloom:lastRelay');
    if (relay && !relayInput.value) relayInput.value = relay;
  } catch {}
}

const darkTermTheme = {
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
};

const lightTermTheme = {
  background: '#1c1c1e',
  foreground: '#e6edf3',
  cursor: '#5856d6',
  cursorAccent: '#1c1c1e',
  selectionBackground: 'rgba(88,86,214,0.30)',
  black: '#1c1c1e',
  red: '#ff3b30',
  green: '#34c759',
  yellow: '#ff9f0a',
  blue: '#5856d6',
  magenta: '#bf5af2',
  cyan: '#32d5d5',
  white: '#d1d1d6',
  brightBlack: '#6e6e73',
  brightRed: '#ff6961',
  brightGreen: '#4cd964',
  brightYellow: '#ffd60a',
  brightBlue: '#7c7aff',
  brightMagenta: '#da8aff',
  brightCyan: '#5ac8fa',
  brightWhite: '#f2f2f7',
};

function getTermTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? lightTermTheme : darkTermTheme;
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
    theme: getTermTheme(),
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalEl);

  // Suppress OSC color query responses at the source. When the PTY shell (e.g.
  // zsh) sends OSC 10/11/… queries, xterm.js auto-replies via onData, which
  // gets forwarded back to the PTY as input and echoed as garbage text.
  // Returning true from these handlers tells xterm.js "handled" so it won't
  // generate a response.  OSC 4 = indexed color, 10 = fg, 11 = bg,
  // 12 = cursor color, 17 = highlight, 19 = highlight fg.
  for (const osc of [4, 10, 11, 12, 17, 19]) {
    term.parser.registerOscHandler(osc, () => true);
  }

  term.onData((data) => {
    if (!terminalReady || !channel) return;
    channel.send({ type: 'terminal_input', data } satisfies TerminalMessage);
  });
  terminalContainer.addEventListener('click', () => term?.focus());
  resizeObserver = new ResizeObserver(() => fitAndSyncTerminal());
  resizeObserver.observe(terminalContainer);
}

// Live-switch the xterm theme when the system color scheme changes
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  term?.options && (term.options.theme = getTermTheme());
});

let lastSentCols = 0;
let lastSentRows = 0;

function fitAndSyncTerminal(openIfNeeded = false) {
  if (!term || !fitAddon) { debug('[viewer] fitAndSyncTerminal: no term or fitAddon'); return; }
  fitAddon.fit();
  if (!channel || !terminalReady) { debug('[viewer] fitAndSyncTerminal: no channel or not ready'); return; }
  const cols = term.cols;
  const rows = term.rows;
  // Only send if dimensions actually changed (prevents zsh prompt redraw spam on orientation)
  if (!openIfNeeded && cols === lastSentCols && rows === lastSentRows) {
    debug(`[viewer] Skipping resize: same dimensions (${cols}x${rows})`);
    return;
  }
  lastSentCols = cols;
  lastSentRows = rows;
  const message: TerminalMessage = openIfNeeded
    ? { type: 'terminal_open', cols, rows }
    : { type: 'terminal_resize', cols, rows };
  debug(`[viewer] Sending ${message.type} (${cols}x${rows})`);
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
  lastSentCols = 0;
  lastSentRows = 0;
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

// Shrink the app to the visual viewport height so the terminal stays visible
// when the phone keyboard appears. Also collapses the header in landscape mode
// to maximise the terminal area.
const appEl = document.getElementById('app')!;
let _vpRAF = 0;
function applyVisualViewport() {
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  appEl.style.height = `${vv.height}px`;
  appEl.style.top = `${vv.offsetTop}px`;
  // Compact header when in landscape orientation
  terminalScreen.classList.toggle('landscape', vv.width > vv.height);
  // Defer terminal fit until the layout reflows with the new dimensions
  cancelAnimationFrame(_vpRAF);
  _vpRAF = requestAnimationFrame(() => fitAndSyncTerminal());
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', applyVisualViewport);
  window.visualViewport.addEventListener('scroll', applyVisualViewport);
  // Apply on initial load so the terminal is sized correctly from the start
  applyVisualViewport();
}
// Re-apply after orientation settles (layout dimensions aren't immediately final)
window.addEventListener('orientationchange', () => setTimeout(applyVisualViewport, 300));

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
  if (hash) {
    // Clear the hash immediately so if the user adds to home screen the saved URL
    // is the clean base URL, not a stale pairing URL with an expiring token.
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const json = atob(hash.replace(/-/g, '+').replace(/_/g, '/'));
      await connectWithQR(json);
    } catch { /* ignore */ }
    if (!channel) hideError();
    return;
  }

  // No hash — try to auto-reconnect using the last saved session (for home screen opens).
  const saved = loadLastSession();
  if (!saved) return;
  showStatus('Reconnecting...');
  const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + saved.session));
  const encryptionKey = deriveEncryptionKey(keyMaterial);
  try {
    // 8-second peer timeout: if the host is on a new session it will never appear,
    // so fail cleanly rather than hanging on "waiting for host".
    await doConnect(saved.relay, saved.session, encryptionKey, saved.transport, saved.token, 8000);
  } catch (err) {
    debug(`[viewer] Auto-reconnect failed: ${err instanceof Error ? err.message : err}`);
  }
  if (!channel) {
    // Saved session is stale — clear it and show clean connect screen
    clearLastSession();
    hideError();
    hideStatus();
  }
})();

async function connectWithCode() {
  const raw = parsePairingCode(codeInput.value);
  if (raw.length !== 8) { showError('Code must be 8 characters'); return; }
  const sessionToken = deriveSessionToken(raw);
  const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + sessionToken));
  const encryptionKey = deriveEncryptionKey(keyMaterial);

  // Ask the host for its current Ably token using the session derived from the code.
  // Try the current page origin first (we're served from the host on LAN), then any
  // saved host origin from a previous QR connection.
  const saved = loadLastSession();
  const originsToTry = [...new Set([location.origin, saved?.hostOrigin].filter(Boolean) as string[])];
  for (const origin of originsToTry) {
    try {
      const res = await fetch(`${origin}/api/pair?session=${encodeURIComponent(sessionToken)}`);
      if (res.ok) {
        const data = await res.json() as { token: string; transport: 'ably' | 'ws'; relay: string };
        saveConnectionParams(codeInput.value, data.relay);
        // Save session for home screen auto-reconnect (same as QR flow)
        saveLastSession({ session: sessionToken, token: data.token, transport: data.transport, relay: data.relay, hostOrigin: origin });
        await doConnect(data.relay, sessionToken, encryptionKey, data.transport, data.token);
        return;
      }
    } catch { /* try next origin */ }
  }

  // /api/pair failed — fall back to the saved Ably token from a previous QR session.
  // This covers the home-screen / cross-origin case where the host isn't reachable
  // via HTTP but Ably relay still works.
  if (saved?.token && saved.transport === 'ably') {
    saveLastSession({ ...saved, session: sessionToken });
    await doConnect(saved.relay, sessionToken, encryptionKey, 'ably', saved.token);
    return;
  }

  // Last resort: try self-hosted WS relay (for users who run their own relay)
  const relayUrl = relayInput.value.trim() || 'ws://localhost:4500';
  saveConnectionParams(codeInput.value, relayUrl);
  await doConnect(relayUrl, sessionToken, encryptionKey);
}

async function connectWithQR(qrText: string) {
  try {
    const data = decodePairingData(qrText);
    saveConnectionParams(null, data.relay);
    const transport = data.transport ?? 'ws';
    // Save session for home screen auto-reconnect
    saveLastSession({ session: data.session, token: data.token, transport, relay: data.relay, hostOrigin: location.origin });
    const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + data.session));
    const encryptionKey = deriveEncryptionKey(keyMaterial);
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

async function doConnect(relayUrl: string, sessionToken: string, encryptionKey: Uint8Array, transport: 'ws' | 'ably' = 'ws', token?: string, peerTimeoutMs = 0) {
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

    let peerTimer: ReturnType<typeof setTimeout> | null = null;
    if (peerTimeoutMs > 0) {
      peerTimer = setTimeout(() => {
        if (!terminalReady) {
          const c = channel;
          channel = null;
          c?.close();
          hideError();
        }
      }, peerTimeoutMs);
    }

    channel.on('ready', () => {
      if (peerTimer) { clearTimeout(peerTimer); peerTimer = null; }
      debug('[viewer] Channel ready');
      terminalReady = true;
      connectScreen.style.display = 'none';
      terminalScreen.style.display = 'flex';
      setTerminalStatus('Connected');
      ensureTerminal();
      debug('[viewer] Terminal ensured, calling fitAndSyncTerminal(true)');
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
        debug('[viewer] Non-terminal stream, ignoring');
        return;
      }
      debug('[viewer] Terminal stream received');
      ensureTerminal();
      stream.on('data', (chunk: string) => {
        term?.write(chunk);
      });
      stream.on('end', () => {
        debug('[viewer] Stream ended');
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
    const failed = channel;
    channel = null;
    try { failed?.close(); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : 'Unknown error';
    showError('Connection failed: ' + message);
  }
}

function showError(msg: string) { connectError.textContent = msg; connectError.style.display = 'block'; }
function hideError() { connectError.style.display = 'none'; }
function hideStatus() { connectStatus.style.display = 'none'; }
function showStatus(msg: string) { connectStatus.textContent = msg; connectStatus.style.display = 'block'; }
