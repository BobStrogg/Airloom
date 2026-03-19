import { Channel, WebSocketAdapter, AblyAdapter, type ReadStream } from '@airloom/channel';
import type { RelayAdapter } from '@airloom/channel';
import { deriveSessionToken, deriveEncryptionKey, parsePairingCode } from '@airloom/crypto';
import { decodePairingData } from '@airloom/protocol';
import { sha256 } from '@noble/hashes/sha256';
import { marked } from 'marked';

// Configure marked for chat-style rendering
marked.setOptions({ gfm: true, breaks: true });

/** Render markdown to HTML. User messages are escaped plain text. */
function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

// Register service worker so the viewer works even after leaving the host's LAN.
// After the SW is active, eagerly cache all same-origin assets (JS/CSS bundles)
// and the page itself so a refresh while offline serves the full app.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => (reg.active ? Promise.resolve() : new Promise<void>((r) => {
      const sw = reg.installing ?? reg.waiting;
      if (sw) sw.addEventListener('statechange', () => { if (sw.state === 'activated') r(); });
      else r();
    })).then(async () => {
      const cache = await caches.open('airloom-v2');
      // Cache the page URL itself (Performance API only captures sub-resources)
      const pageUrl = location.href.split('#')[0];
      const pageHit = await cache.match(pageUrl);
      if (!pageHit) await cache.add(pageUrl).catch(() => {});
      // Cache every same-origin sub-resource this page loaded (Vite hashed JS/CSS)
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const urls = entries
        .map((e) => e.name)
        .filter((u) => { try { return new URL(u).origin === location.origin; } catch { return false; } });
      await Promise.all(urls.map((u) => cache.match(u).then((hit) => { if (!hit) return cache.add(u).catch(() => {}); })));
    }))
    .catch(() => {});
}

const connectScreen = document.getElementById('connectScreen')!;
const chatScreen = document.getElementById('chatScreen')!;
const scanBtn = document.getElementById('scanBtn')!;
const joinBtn = document.getElementById('joinBtn')!;
const codeInput = document.getElementById('codeInput') as HTMLInputElement;
const relayInput = document.getElementById('relayInput') as HTMLInputElement;
const connectError = document.getElementById('connectError')!;
const connectStatus = document.getElementById('connectStatus')!;
const messagesEl = document.getElementById('messages')!;
const messageInput = document.getElementById('messageInput') as HTMLTextAreaElement;
const sendBtn = document.getElementById('sendBtn')!;
const disconnectBtn = document.getElementById('disconnectBtn')!;
const chatStatus = document.getElementById('chatStatus')!;
const qrReaderEl = document.getElementById('qrReader')!;

let channel: Channel | null = null;
let currentStreamEl: HTMLDivElement | null = null;
let currentStreamText = '';

// Auto-format code input with dash
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

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
});

disconnectBtn.addEventListener('click', () => {
  channel?.close();
  channel = null;
  chatScreen.style.display = 'none';
  connectScreen.style.display = 'flex';
  messagesEl.innerHTML = '';
});

// Auto-connect if URL hash contains base64url-encoded pairing data
(async () => {
  const hash = location.hash.slice(1); // strip leading '#'
  if (!hash) return;
  try {
    // Decode base64url → JSON string → pairing data
    const json = atob(hash.replace(/-/g, '+').replace(/_/g, '/'));
    await connectWithQR(json);
  } catch {
    // not valid pairing data — ignore, user can connect manually
  }
})();

async function connectWithCode() {
  const raw = parsePairingCode(codeInput.value);
  if (raw.length !== 8) { showError('Code must be 8 characters'); return; }
  const relayUrl = relayInput.value.trim() || 'ws://localhost:4500';
  const sessionToken = deriveSessionToken(raw);
  const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + sessionToken));
  const encryptionKey = deriveEncryptionKey(keyMaterial);
  await doConnect(relayUrl, sessionToken, encryptionKey);
}

async function connectWithQR(qrText: string) {
  try {
    const data = decodePairingData(qrText);
    const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + data.session));
    const encryptionKey = deriveEncryptionKey(keyMaterial);
    const transport = data.transport ?? 'ws';
    await doConnect(data.relay, data.session, encryptionKey, transport, data.token);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showError('Invalid QR code: ' + message);
  }
}

async function doConnect(relayUrl: string, sessionToken: string, encryptionKey: Uint8Array, transport: 'ws' | 'ably' = 'ws', token?: string) {
  showStatus('Connecting...'); hideError();
  try {
    let adapter: RelayAdapter;
    if (transport === 'ably') {
      if (!token) { showError('Ably transport requires a token'); return; }
      adapter = new AblyAdapter({ token }); // scoped token from QR — root key never exposed
    } else {
      adapter = new WebSocketAdapter(relayUrl);
    }
    channel = new Channel({ adapter, role: 'viewer', encryptionKey });

    channel.on('ready', () => {
      connectScreen.style.display = 'none';
      chatScreen.style.display = 'flex';
      chatStatus.textContent = 'Connected';
      chatStatus.className = 'status-badge';
    });
    channel.on('peer_left', () => {
      chatStatus.textContent = 'Disconnected';
      chatStatus.className = 'status-badge disconnected';
    });
    channel.on('message', (data: unknown) => {
      if (typeof data === 'string') {
        addMessage('assistant', data);
      } else if (typeof data === 'object' && data !== null && 'content' in data) {
        const msg = data as Record<string, unknown>;
        const role = typeof msg.role === 'string' ? msg.role : 'assistant';
        if (typeof msg.content === 'string') addMessage(role, msg.content);
      }
    });
    channel.on('stream', (stream: ReadStream) => {
      currentStreamEl = addMessage('assistant', '');
      currentStreamEl.classList.add('typing');
      currentStreamEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
      currentStreamText = '';
      stream.on('data', (chunk: string) => {
        currentStreamText += chunk;
        if (currentStreamEl) {
          if (currentStreamEl.classList.contains('typing')) {
            currentStreamEl.classList.remove('typing');
          }
          const trimmed = currentStreamText.trimStart();
          currentStreamEl.innerHTML = renderMarkdown(trimmed);
          currentStreamEl.scrollIntoView({ block: 'end', behavior: 'smooth' });
        }
      });
      stream.on('end', () => { currentStreamEl = null; currentStreamText = ''; });
    });
    channel.on('error', (err: Error) => console.error('Channel error:', err));
    channel.on('disconnect', () => {
      chatStatus.textContent = 'Disconnected';
      chatStatus.className = 'status-badge disconnected';
    });

    await channel.connect(sessionToken);
    showStatus('Connected to relay, waiting for host...');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showError('Connection failed: ' + message);
  }
}

function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || !channel) return;
  messageInput.value = '';
  messageInput.style.height = 'auto';
  addMessage('user', content);
  channel.send({ type: 'chat', content });
}

function addMessage(role: string, content: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role === 'user' || !content) {
    el.textContent = content;
  } else {
    el.innerHTML = renderMarkdown(content);
  }
  messagesEl.appendChild(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return el;
}

function showError(msg: string) { connectError.textContent = msg; connectError.style.display = 'block'; }
function hideError() { connectError.style.display = 'none'; }
function showStatus(msg: string) { connectStatus.textContent = msg; connectStatus.style.display = 'block'; }
