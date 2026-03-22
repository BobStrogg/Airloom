import { Channel, WebSocketAdapter, AblyAdapter, type ReadStream } from '@airloom/channel';
import type { RelayAdapter } from '@airloom/channel';
import { deriveSessionToken, deriveEncryptionKey, parsePairingCode } from '@airloom/crypto';
import { parsePairingInput, type SessionRefreshMessage, type TerminalExitMessage, type TerminalMessage, type TerminalStreamMeta } from '@airloom/protocol';
import { sha256 } from '@noble/hashes/sha256';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  buildCodeConnectPlan,
  canAutoReconnectSavedSession,
  fetchPairingSession,
  getNextStoredRelay,
  getRelayInputPlaceholder,
  normalizeStoredRelay,
  type CodeConnectAttempt,
} from './pairing.js';
import { clearSavedSession, loadSavedSession, saveSavedSession } from './session-store.js';

function debug(msg: string) {
  console.log(msg);
}

// Surface uncaught errors / rejections so the user sees a message instead of
// a blank white page.  This is especially important on mobile where devtools
// aren't easily accessible.
window.addEventListener('error', (e) => {
  const el = document.getElementById('connectError');
  if (el) { el.textContent = `Error: ${e.message}`; el.style.display = 'block'; }
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  const el = document.getElementById('connectError');
  if (el) { el.textContent = `Error: ${msg}`; el.style.display = 'block'; }
});

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
const upBtn = document.getElementById('upBtn')!;
const downBtn = document.getElementById('downBtn')!;
const leftBtn = document.getElementById('leftBtn')!;
const rightBtn = document.getElementById('rightBtn')!;
const fontDownBtn = document.getElementById('fontDownBtn')!;
const fontUpBtn = document.getElementById('fontUpBtn')!;

let channel: Channel | null = null;
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let terminalReady = false;
let connecting = false;
const PEER_READY_TIMEOUT_MS = 8000;
const CODE_CONNECT_FAILURE_MESSAGE = 'Could not connect with this code. Scan the QR code once or enter your WebSocket relay URL.';

function saveConnectionParams(_code: string | null, relayUrl: string) {
  try {
    const nextRelay = getNextStoredRelay(localStorage.getItem('airloom:lastRelay'), relayUrl);
    if (nextRelay) {
      localStorage.setItem('airloom:lastRelay', nextRelay);
    } else {
      localStorage.removeItem('airloom:lastRelay');
    }
  } catch {}
}

function restoreConnectionParams() {
  try {
    const relay = normalizeStoredRelay(localStorage.getItem('airloom:lastRelay'));
    if (relay && !relayInput.value) {
      relayInput.value = relay;
    } else if (!relay) {
      localStorage.removeItem('airloom:lastRelay');
    }
  } catch {}
}

function syncRelayInputPlaceholder() {
  relayInput.placeholder = getRelayInputPlaceholder(location.hostname);
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
  background: '#ffffff',
  foreground: '#1c1c1e',
  cursor: '#5856d6',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(88,86,214,0.20)',
  black: '#1c1c1e',
  red: '#c41a16',
  green: '#007400',
  yellow: '#826b28',
  blue: '#0000ff',
  magenta: '#a90d91',
  cyan: '#3e8a8a',
  white: '#e5e5ea',
  brightBlack: '#6e6e73',
  brightRed: '#eb4d3d',
  brightGreen: '#36b738',
  brightYellow: '#b79a14',
  brightBlue: '#0451a5',
  brightMagenta: '#c42275',
  brightCyan: '#318495',
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
    fontSize: getSavedFontSize(),
    lineHeight: 1.25,
    allowTransparency: true,
    scrollback: 5000,
    smoothScrollDuration: 80,
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

  // xterm.js v6 uses a VS Code-style scrollable element that only handles
  // `wheel` events — touch scrolling is not supported out of the box.  Wire up
  // a simple touch-to-scroll bridge so mobile users can scroll the terminal.
  {
    let touchY: number | null = null;
    let remainder = 0;
    const cellH = () => term!.options.lineHeight! * term!.options.fontSize!;
    terminalEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) { touchY = e.touches[0].clientY; remainder = 0; }
    }, { passive: true });
    terminalEl.addEventListener('touchmove', (e) => {
      if (touchY === null || e.touches.length !== 1 || !term) return;
      const dy = touchY - e.touches[0].clientY;
      touchY = e.touches[0].clientY;
      const h = cellH();
      remainder += dy;
      const lines = Math.trunc(remainder / h);
      if (lines !== 0) {
        term.scrollLines(lines);
        remainder -= lines * h;
      }
      e.preventDefault();
    }, { passive: false });
    terminalEl.addEventListener('touchend', () => { touchY = null; remainder = 0; }, { passive: true });
    terminalEl.addEventListener('touchcancel', () => { touchY = null; remainder = 0; }, { passive: true });
  }

  resizeObserver = new ResizeObserver(() => fitAndSyncTerminal());
  resizeObserver.observe(terminalContainer);
}

// Live-switch the xterm theme when the system color scheme changes
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (term) term.options.theme = getTermTheme();
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
  connecting = false;
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
syncRelayInputPlaceholder();

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
  if (terminalReady && channel) channel.send({ type: 'terminal_input', data: '\x03' } satisfies TerminalMessage);
});
escBtn.addEventListener('click', () => {
  term?.focus();
  if (terminalReady && channel) channel.send({ type: 'terminal_input', data: '\x1b' } satisfies TerminalMessage);
});
tabBtn.addEventListener('click', () => {
  term?.focus();
  if (terminalReady && channel) channel.send({ type: 'terminal_input', data: '\t' } satisfies TerminalMessage);
});
upBtn.addEventListener('click', () => {
  term?.focus();
  if (terminalReady && channel) channel.send({ type: 'terminal_input', data: '\x1b[A' } satisfies TerminalMessage);
});
downBtn.addEventListener('click', () => {
  term?.focus();
  if (terminalReady && channel) channel.send({ type: 'terminal_input', data: '\x1b[B' } satisfies TerminalMessage);
});
leftBtn.addEventListener('click', () => {
  term?.focus();
  if (terminalReady && channel) channel.send({ type: 'terminal_input', data: '\x1b[D' } satisfies TerminalMessage);
});
rightBtn.addEventListener('click', () => {
  term?.focus();
  if (terminalReady && channel) channel.send({ type: 'terminal_input', data: '\x1b[C' } satisfies TerminalMessage);
});

const FONT_MIN = 8;
const FONT_MAX = 24;
const FONT_STEP = 1;
const FONT_KEY = 'airloom:fontSize';

function setFontSize(size: number) {
  const clamped = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
  if (!term) return;
  term.options.fontSize = clamped;
  fitAndSyncTerminal();
  try { localStorage.setItem(FONT_KEY, String(clamped)); } catch {}
}

function getSavedFontSize(): number {
  try {
    const v = localStorage.getItem(FONT_KEY);
    if (v) { const n = Number(v); if (n >= FONT_MIN && n <= FONT_MAX) return n; }
  } catch {}
  return 14;
}

fontDownBtn.addEventListener('click', () => {
  if (term) setFontSize(term.options.fontSize! - FONT_STEP);
});
fontUpBtn.addEventListener('click', () => {
  if (term) setFontSize(term.options.fontSize! + FONT_STEP);
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
    await connectWithQR(hash);
    return;
  }

  debug('[viewer] No hash, checking saved session...');
  let saved: Awaited<ReturnType<typeof loadSavedSession>>;
  try {
    saved = await loadSavedSession();
  } catch (err) {
    debug(`[viewer] loadSavedSession error: ${err}`);
    showStatus(`Session load error: ${err}`);
    await new Promise((r) => setTimeout(r, 3000));
    hideStatus();
    return;
  }
  if (!saved) {
    debug('[viewer] No saved session found');
    showStatus('No saved session');
    await new Promise((r) => setTimeout(r, 1500));
    hideStatus();
    return;
  }
  debug(`[viewer] Saved session: transport=${saved.transport}, relay=${saved.relay}, session=${saved.session.slice(0, 8)}…, hasToken=${!!saved.token}, tokenExpiresAt=${saved.tokenExpiresAt}`);
  if (!canAutoReconnectSavedSession(saved)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS narrows to never after the type guard
    const s = saved as any;
    const reason = !s.token ? 'no token' : s.tokenExpiresAt ? `token expired (${new Date(s.tokenExpiresAt as number).toISOString()})` : 'unknown';
    debug(`[viewer] Saved session not reconnectable: ${reason}`);
    showStatus(`Session not reconnectable: ${reason}`);
    await new Promise((r) => setTimeout(r, 2000));
    hideStatus();
    return;
  }
  showStatus('Reconnecting...');
  const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + saved.session));
  const encryptionKey = deriveEncryptionKey(keyMaterial);
  const reconnected = await doConnect(saved.relay, saved.session, encryptionKey, saved.transport, saved.token, {
    waitForReadyTimeoutMs: PEER_READY_TIMEOUT_MS,
    suppressFailureUI: true,
  });
  if (!reconnected || !channel) {
    debug('[viewer] Auto-reconnect failed, clearing saved session');
    await clearSavedSession();
    hideError();
    hideStatus();
  }
})();

async function connectWithCode() {
  if (connecting) return;
  const raw = parsePairingCode(codeInput.value);
  if (raw.length !== 8) { showError('Code must be 8 characters'); return; }
  const pairingSessionToken = deriveSessionToken(raw);
  const saved = await loadSavedSession();
  const pairSession = await fetchPairingSession(fetch, location.origin, pairingSessionToken);

  // When the viewer is served by the host (same-origin), the host can exchange
  // the code-derived session token for the current transport details.
  // QR payloads are untrusted, so only the current page origin can answer this.
  const connectPlan = buildCodeConnectPlan({
    pairSession,
    saved,
    relayInputValue: relayInput.value,
    viewerHostname: location.hostname,
  });

  for (const attempt of connectPlan.attempts) {
    if (await tryCodeConnectAttempt(attempt, pairingSessionToken)) {
      return;
    }
  }

  const fallbackCount = connectPlan.attempts.filter((attempt) => attempt.kind !== 'pair-session').length;
  if (connectPlan.relayInputError && fallbackCount === 0) {
    showError(connectPlan.relayInputError);
    return;
  }
  if (connectPlan.relayInputError) {
    showError(`${CODE_CONNECT_FAILURE_MESSAGE} ${connectPlan.relayInputError} if you enter one.`);
    return;
  }
  showError(CODE_CONNECT_FAILURE_MESSAGE);
}

async function tryCodeConnectAttempt(
  attempt: CodeConnectAttempt,
  pairingSessionToken: string,
): Promise<boolean> {
  if (attempt.kind === 'pair-session') {
    const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + attempt.session));
    const encryptionKey = deriveEncryptionKey(keyMaterial);
    const connected = await doConnect(attempt.relay, attempt.session, encryptionKey, attempt.transport, attempt.token, {
      waitForReadyTimeoutMs: PEER_READY_TIMEOUT_MS,
      suppressFailureUI: true,
    });
    if (connected) {
      saveConnectionParams(codeInput.value, attempt.relay);
      await saveSavedSession({
        session: attempt.session,
        token: attempt.token,
        tokenExpiresAt: attempt.tokenExpiresAt,
        transport: attempt.transport,
        relay: attempt.relay,
      });
    }
    return connected;
  }

  if (attempt.kind === 'saved-ably') {
    const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + attempt.session));
    const encryptionKey = deriveEncryptionKey(keyMaterial);
    const connected = await doConnect(attempt.relay, attempt.session, encryptionKey, 'ably', attempt.token, {
      waitForReadyTimeoutMs: PEER_READY_TIMEOUT_MS,
      suppressFailureUI: true,
    });
    if (connected) {
      await saveSavedSession({
        session: attempt.session,
        token: attempt.token,
        tokenExpiresAt: attempt.tokenExpiresAt,
        transport: 'ably',
        relay: attempt.relay,
      });
    }
    return connected;
  }

  const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + pairingSessionToken));
  const encryptionKey = deriveEncryptionKey(keyMaterial);
  const connected = await doConnect(attempt.relay, pairingSessionToken, encryptionKey, 'ws', undefined, {
    waitForReadyTimeoutMs: PEER_READY_TIMEOUT_MS,
    suppressFailureUI: true,
  });
  if (connected) {
    saveConnectionParams(codeInput.value, attempt.relay);
    await saveSavedSession({
      session: pairingSessionToken,
      transport: 'ws',
      relay: attempt.relay,
    });
  }
  return connected;
}

async function connectWithQR(qrText: string) {
  try {
    const data = parsePairingInput(qrText);
    const transport = data.transport ?? 'ws';
    const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + data.session));
    const encryptionKey = deriveEncryptionKey(keyMaterial);
    const connected = await doConnect(data.relay, data.session, encryptionKey, transport, data.token);
    if (connected) {
      saveConnectionParams(null, data.relay);
      await saveSavedSession({
        session: data.session,
        token: data.token,
        tokenExpiresAt: data.tokenExpiresAt,
        transport,
        relay: data.relay,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showError('Invalid QR code: ' + message);
  }
}

function isTerminalStream(stream: ReadStream): boolean {
  const meta = stream.meta as Partial<TerminalStreamMeta> | undefined;
  return meta?.kind === 'terminal';
}

function isSessionRefreshMessage(data: unknown): data is SessionRefreshMessage {
  if (!data || typeof data !== 'object' || !('type' in data)) return false;
  const message = data as Record<string, unknown>;
  if (message.type !== 'session_refresh') return false;
  if (typeof message.session !== 'string' || typeof message.relay !== 'string') return false;
  if (message.transport !== 'ws' && message.transport !== 'ably') return false;
  if (message.token !== undefined && typeof message.token !== 'string') return false;
  if (message.tokenExpiresAt !== undefined && typeof message.tokenExpiresAt !== 'number') return false;
  return true;
}

interface ConnectOptions {
  waitForReadyTimeoutMs?: number;
  suppressFailureUI?: boolean;
}

async function doConnect(
  relayUrl: string,
  sessionToken: string,
  encryptionKey: Uint8Array,
  transport: 'ws' | 'ably' = 'ws',
  token?: string,
  opts: ConnectOptions = {},
): Promise<boolean> {
  connecting = true;
  showStatus('Connecting...');
  hideError();
  try {
    let adapter: RelayAdapter;
    if (transport === 'ably') {
      if (!token) throw new Error('Ably transport requires a token');
      adapter = new AblyAdapter({ token });
    } else {
      adapter = new WebSocketAdapter(relayUrl);
    }
    channel = new Channel({ adapter, role: 'viewer', encryptionKey });

    channel.on('ready', () => {
      connecting = false;
      debug('[viewer] Channel ready');
      terminalReady = true;
      connectScreen.style.display = 'none';
      terminalScreen.style.display = 'flex';
      setTerminalStatus('Connected');
      ensureTerminal();
      // Use setTimeout instead of requestAnimationFrame — on iOS the terminal
      // screen just switched from display:none to display:flex, and rAF may
      // fire before the layout reflows, giving the terminal zero dimensions.
      // A short timeout lets the layout settle so fitAddon gets correct sizes.
      setTimeout(() => {
        fitAndSyncTerminal(true);
        term?.focus();
      }, 100);
    });
    channel.on('peer_left', () => {
      setTerminalStatus('Disconnected', 'status-badge disconnected');
      writeTerminalLine('');
      writeTerminalLine('[host disconnected]');
    });
    channel.on('message', (data: unknown) => {
      if (!data || typeof data !== 'object' || !('type' in data)) return;
      if (isSessionRefreshMessage(data)) {
        void saveSavedSession({
          session: data.session,
          token: data.token,
          tokenExpiresAt: data.tokenExpiresAt,
          transport: data.transport,
          relay: data.relay,
        });
        return;
      }
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
    if (opts.waitForReadyTimeoutMs) {
      await channel.waitForReady(opts.waitForReadyTimeoutMs);
    }
    return true;
  } catch (err: unknown) {
    connecting = false;
    const failed = channel;
    channel = null;
    try { failed?.close(); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (opts.suppressFailureUI) {
      debug(`[viewer] Connection attempt failed: ${message}`);
      hideError();
      hideStatus();
    } else {
      showError('Connection failed: ' + message);
    }
    return false;
  }
}

function showError(msg: string) { connectError.textContent = msg; connectError.style.display = 'block'; }
function hideError() { connectError.style.display = 'none'; }
function hideStatus() { connectStatus.style.display = 'none'; }
function showStatus(msg: string) { connectStatus.textContent = msg; connectStatus.style.display = 'block'; }
