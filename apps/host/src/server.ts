import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import type { Channel } from '@airloom/channel';
import { Batcher } from '@airloom/channel';
import type { AIAdapter } from './adapters/types.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { CLIAdapter, CLI_PRESETS } from './adapters/cli.js';
import { loadConfig, saveConfig } from './config.js';
import { getTerminalLaunchDisplay } from './terminal.js';
import type { SavedConfig } from './config.js';

export interface ServerState {
  channel: Channel | null;
  adapter: AIAdapter | null;
  pairingCode: string;
  pairingQR: string;
  relayUrl: string;
  connected: boolean;
  terminalLaunch: string;
  terminalLaunchCommand?: string;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  terminal?: { writeRawInput(data: string): void; handleMessage(msg: unknown): void };
  sessionToken?: string;
  ablyToken?: string;
  transport?: 'ably' | 'ws';
}

const MAX_MESSAGES = 200;

function trimMessages(messages: ServerState['messages']): void {
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
}

let aiLock: Promise<void> = Promise.resolve();

export function enqueueAIResponse(
  channel: Channel,
  adapter: AIAdapter,
  state: ServerState,
  broadcast: (data: unknown) => void,
): void {
  aiLock = aiLock
    .then(() => handleAIResponse(channel, adapter, state, broadcast))
    .catch((err) => console.error('[host] AI response error:', err));
}

export function createHostServer(opts: {
  port: number;
  state: ServerState;
  viewerDir?: string;
}) {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const uiClients = new Set<WebSocket>();

  app.use(express.json());

  app.get('/', (_req, res) => { res.type('html').send(HOST_HTML); });

  // Serve viewer app under /viewer/ (static files from viewer build)
  if (opts.viewerDir && existsSync(opts.viewerDir)) {
    app.use('/viewer', express.static(opts.viewerDir));
  }

  app.get('/api/status', (_req, res) => {
    res.json({
      connected: opts.state.connected,
      pairingCode: opts.state.pairingCode,
      pairingQR: opts.state.pairingQR,
      relayUrl: opts.state.relayUrl,
      adapter: opts.state.adapter ? { name: opts.state.adapter.name, model: opts.state.adapter.model } : null,
      terminalLaunch: opts.state.terminalLaunch,
      messages: opts.state.messages,
    });
  });

  app.get('/api/cli-presets', (_req, res) => { res.json(CLI_PRESETS); });

  app.get('/api/config', (_req, res) => {
    const saved = loadConfig();
    // Also surface env-var API keys so UI can show "from env" hint
    res.json({
      saved,
      envKeys: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
      },
    });
  });

  app.post('/api/configure', (req, res) => {
    const { type, apiKey, model, command, preset } = req.body;
    try {
      switch (type) {
        case 'anthropic': {
          const key = apiKey || process.env.ANTHROPIC_API_KEY;
          if (!key) { res.status(400).json({ error: 'API key required (or set ANTHROPIC_API_KEY env var)' }); return; }
          opts.state.adapter = new AnthropicAdapter({ apiKey: key, model });
          break;
        }
        case 'openai': {
          const key = apiKey || process.env.OPENAI_API_KEY;
          if (!key) { res.status(400).json({ error: 'API key required (or set OPENAI_API_KEY env var)' }); return; }
          opts.state.adapter = new OpenAIAdapter({ apiKey: key, model });
          break;
        }
        case 'cli': {
          const selectedPreset = typeof preset === 'string' ? preset : 'shell';
          const presetInfo = CLI_PRESETS.find((p) => p.id === selectedPreset);
          const cmd = selectedPreset === 'shell'
            ? undefined
            : (typeof command === 'string' && command.trim())
              ? command.trim()
              : presetInfo?.command;
          opts.state.terminalLaunchCommand = cmd;
          opts.state.terminalLaunch = getTerminalLaunchDisplay(cmd);
          opts.state.adapter = null;
          const cfg: SavedConfig = { type: 'terminal', preset: selectedPreset, command: cmd };
          saveConfig(cfg);
          broadcast({ type: 'terminal_configured', terminalLaunch: opts.state.terminalLaunch });
          res.json({ ok: true, terminalLaunch: opts.state.terminalLaunch });
          return;
        }
        default: res.status(400).json({ error: 'Unknown adapter type' }); return;
      }
      const cfg: SavedConfig = { type };
      if (model) cfg.model = model;
      if (type === 'cli') { cfg.command = command; cfg.preset = preset; }
      saveConfig(cfg);
      broadcast({ type: 'configured', adapter: { name: opts.state.adapter?.name ?? 'none', model: opts.state.adapter?.model ?? '' } });
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Configuration failed';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/send', async (req, res) => {
    const { content } = req.body;
    if (!content) { res.status(400).json({ error: 'No content' }); return; }

    opts.state.messages.push({ role: 'user', content, timestamp: Date.now() });
    trimMessages(opts.state.messages);
    broadcast({ type: 'message', role: 'user', content });

    if (opts.state.adapter && opts.state.channel) {
      enqueueAIResponse(opts.state.channel, opts.state.adapter, opts.state, broadcast);
    }
    res.json({ ok: true });
  });

  // Allows the phone to exchange an 8-character pairing code for the current
  // Ably session token without needing to re-scan the QR code.
  app.get('/api/pair', (req, res) => {
    const { session } = req.query as Record<string, string>;
    if (!session || session !== opts.state.sessionToken) {
      res.status(401).json({ error: 'Invalid session' });
      return;
    }
    res.json({
      token: opts.state.ablyToken,
      transport: opts.state.transport ?? 'ws',
      relay: opts.state.relayUrl,
    });
  });

  wss.on('connection', (ws) => {
    uiClients.add(ws);
    ws.on('close', () => uiClients.delete(ws));
    
    // Handle messages from the host web UI.
    // Only forward terminal_input — terminal_open/resize are exclusively driven
    // by the phone (channel) so the PTY/stream are never created prematurely.
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'terminal_input' && typeof message.data === 'string') {
          opts.state.terminal?.writeRawInput(message.data);
        } else if (message.type === 'terminal_resize') {
          opts.state.terminal?.handleMessage(message);
        }
      } catch (err) {
        console.error('[host] Invalid WebSocket message:', err);
      }
    });
  });

  function broadcast(data: unknown) {
    const msg = JSON.stringify(data);
    for (const ws of uiClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  return new Promise<{ server: ReturnType<typeof createServer>; broadcast: typeof broadcast; port: number }>((resolve) => {
    server.listen(opts.port, '0.0.0.0', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ server, broadcast, port: actualPort });
    });

    server.on('error', (err: Error) => {
      console.error(`[host] Server error: ${err.message}`);
      process.exit(1);
    });
  });
}

export async function handleAIResponse(
  channel: Channel,
  adapter: AIAdapter,
  state: ServerState,
  broadcast: (data: unknown) => void,
) {
  const stream = channel.createStream({ model: adapter.model });
  let fullResponse = '';

  // UI batcher — fast updates for the host web UI (local WebSocket, cheap)
  const uiBatcher = new Batcher({
    interval: 100,
    onFlush: (data: string) => broadcast({ type: 'stream_chunk', data }),
  });

  // Relay batcher — slower cadence to reduce Ably message costs.
  // Each flush is an Ably publish, so batching at 500ms significantly reduces message count.
  const origWrite = stream.write.bind(stream);
  const relayBatcher = new Batcher({
    interval: 500,
    maxBytes: 4096,
    onFlush: (data: string) => origWrite(data),
  });

  stream.write = (data: string) => { fullResponse += data; uiBatcher.write(data); relayBatcher.write(data); };

  const origEnd = stream.end.bind(stream);
  stream.end = () => {
    uiBatcher.flush();
    relayBatcher.flush();
    broadcast({ type: 'stream_end' });
    state.messages.push({ role: 'assistant', content: fullResponse, timestamp: Date.now() });
    trimMessages(state.messages);
    origEnd();
  };

  try {
    await adapter.streamResponse(state.messages, stream);
  } catch (err: unknown) {
    if (!stream.ended) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      stream.write(`[Error: ${message}]`);
      stream.end();
    }
    uiBatcher.destroy();
    relayBatcher.destroy();
  }
}

const HOST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Airloom - Host</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css">
<style>
  :root{color-scheme:light dark;--bg:#0a0a0a;--surface:#1a1a1a;--border:#2a2a2a;--text:#e0e0e0;--text-muted:#888;--accent:#7c8aff;--accent-hover:#6b79ee;--input-bg:#111;--input-border:#333;--term-bg:#05070c;--tool-bg:#333;--tool-hover:#444;--msg-user:#2a3a6a;--msg-asst:#1e1e1e}
  @media(prefers-color-scheme:light){:root{--bg:#f5f5f7;--surface:#fff;--border:#d1d1d6;--text:#1c1c1e;--text-muted:#6e6e73;--accent:#5856d6;--accent-hover:#4a48c4;--input-bg:#fff;--input-border:#d1d1d6;--term-bg:#fff;--tool-bg:#e5e5ea;--tool-hover:#d1d1d6;--msg-user:#d6d5f7;--msg-asst:#f2f2f7}}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  .container{max-width:800px;margin:0 auto;padding:20px}
  .page-header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
  .page-header svg{width:36px;height:36px;flex-shrink:0}
  .page-header h1{font-size:1.5rem;color:var(--accent)}
  h2{font-size:1.1rem;margin-bottom:12px;color:var(--text-muted)}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
  .status{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .dot{width:8px;height:8px;border-radius:50%}
  .dot.on{background:#4caf50} .dot.off{background:#f44336} .dot.wait{background:#ff9800;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .pairing{text-align:center}
  .pairing img{max-width:200px;margin:16px auto;display:block;border-radius:8px}
  .pairing-code{font-family:monospace;font-size:2rem;letter-spacing:4px;color:var(--accent);margin:12px 0}
  .config-form{display:flex;flex-direction:column;gap:12px}
  select,input,button{padding:10px 14px;border-radius:8px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--text);font-size:.95rem}
  select:focus,input:focus{outline:none;border-color:var(--accent)}
  button{background:var(--accent);color:#fff;border:none;cursor:pointer;font-weight:600}
  button:hover{background:var(--accent-hover)}
  .messages{max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
  .msg{padding:10px 14px;border-radius:10px;max-width:85%;word-break:break-word;font-size:.9rem;line-height:1.5;white-space:pre-wrap}
  .msg.user{background:var(--msg-user);align-self:flex-end}
  .msg.assistant{background:var(--msg-asst);border:1px solid var(--border);align-self:flex-start}
  .input-area{display:flex;gap:8px}
  .input-area textarea{flex:1;resize:none;min-height:44px;max-height:120px;padding:10px 14px;border-radius:8px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--text);font-family:inherit;font-size:.9rem}
  .terminal-container{background:var(--term-bg);border:1px solid var(--border);border-radius:8px;height:420px;overflow:hidden;margin-bottom:12px}
  #terminal{width:100%;height:100%;padding:8px}
  .toolbar{display:flex;gap:8px;margin-bottom:12px}
  .tool-btn{padding:6px 12px;font-size:.85rem;background:var(--tool-bg);border:none;border-radius:6px;color:var(--text);cursor:pointer}
  .tool-btn:hover{background:var(--tool-hover)}
</style>
</head>
<body>
<div class="container">
  <div class="page-header">
    <svg viewBox="0 0 100 100" fill="none"><defs><linearGradient id="lg" x1=".3" y1="0" x2=".7" y2="1"><stop stop-color="#a0aaff"/><stop offset="1" stop-color="#6070ef"/></linearGradient></defs><g stroke="url(#lg)" stroke-width="6" stroke-linecap="round"><line x1="22" y1="88" x2="31" y2="64"/><line x1="36" y1="52" x2="50" y2="15"/><line x1="9" y1="58" x2="59.5" y2="58"/><line x1="73.5" y1="58" x2="91" y2="58"/><line x1="50" y1="15" x2="78" y2="88"/></g></svg>
    <h1>Airloom</h1>
  </div>
  <div class="card">
    <div class="status"><div class="dot wait" id="dot"></div><span id="statusText">Initializing...</span></div>
    <p style="color:var(--text-muted);font-size:.9rem;margin-top:8px" id="launchText">Launch: current shell</p>
  </div>

  <div class="card pairing" id="pairingCard" style="display:none">
    <h2>Connect Your Phone</h2>
    <img id="qrCode" alt="QR Code"/>
    <div class="pairing-code" id="pairingCode"></div>
    <p style="color:var(--text-muted);font-size:.85rem">Scan QR or enter code in viewer</p>
  </div>

  <!-- Terminal mode: shell, Devin, Codex etc. (default when no AI adapter) -->
  <div id="terminalSection" style="display:none">
    <div class="card">
      <h2>Launch Configuration</h2>
      <div class="config-form">
        <select id="cliPreset"></select>
        <input type="text" id="command" placeholder="Custom launch command" style="display:none"/>
        <p style="color:var(--text-muted);font-size:.8rem;margin-top:4px" id="presetDesc"></p>
        <button id="applyLaunchBtn">Apply Launch Target</button>
      </div>
    </div>
    <div class="card">
      <h2>Terminal</h2>
      <div class="toolbar">
        <button class="tool-btn" id="focusTermBtn">Focus</button>
        <button class="tool-btn" id="ctrlCBtn">Ctrl+C</button>
        <button class="tool-btn" id="escBtn">Esc</button>
        <button class="tool-btn" id="tabBtn">Tab</button>
      </div>
      <div class="terminal-container" id="terminalContainer">
        <div id="terminal"></div>
      </div>
    </div>
  </div>

  <!-- Chat mode: direct LLM connections (Anthropic, OpenAI) -->
  <div id="chatSection" style="display:none">
    <div class="card">
      <h2>Chat</h2>
      <div class="messages" id="messages"></div>
      <div class="input-area">
        <textarea id="messageInput" placeholder="Type your message..." rows="1"></textarea>
        <button id="sendBtn">Send</button>
      </div>
    </div>
  </div>

</div>
<script type="module">
import { Terminal } from 'https://esm.sh/@xterm/xterm@6';
import { FitAddon } from 'https://esm.sh/@xterm/addon-fit@0.11';

const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
let term = null;
let fitAddon = null;
let termInitialized = false;
let cliPresets = [];

const darkTheme = {
  background: '#05070c', foreground: '#e6edf3', cursor: '#7c8aff', cursorAccent: '#05070c',
  selectionBackground: 'rgba(124,138,255,0.28)',
  black: '#0a0d14', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#7c8aff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#c9d1d9',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#a5b4ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};
const lightTheme = {
  background: '#ffffff', foreground: '#1c1c1e', cursor: '#5856d6', cursorAccent: '#ffffff',
  selectionBackground: 'rgba(88,86,214,0.20)',
  black: '#1c1c1e', red: '#c41a16', green: '#007400', yellow: '#826b28',
  blue: '#0000ff', magenta: '#a90d91', cyan: '#3e8a8a', white: '#e5e5ea',
  brightBlack: '#6e6e73', brightRed: '#eb4d3d', brightGreen: '#36b738', brightYellow: '#b79a14',
  brightBlue: '#0451a5', brightMagenta: '#c42275', brightCyan: '#318495', brightWhite: '#f2f2f7',
};
function getTheme() { return matchMedia('(prefers-color-scheme:light)').matches ? lightTheme : darkTheme; }
matchMedia('(prefers-color-scheme:light)').addEventListener('change', () => {
  if (term) term.options.theme = getTheme();
});

function initTerminal() {
  if (termInitialized) return;
  termInitialized = true;
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
    fontSize: 14,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: getTheme(),
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  // Suppress OSC color query responses — see viewer/main.ts for details.
  for (const osc of [4, 10, 11, 12, 17, 19]) {
    term.parser.registerOscHandler(osc, () => true);
  }
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'terminal_input', data }));
  });
  new ResizeObserver(() => {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN && term) {
      ws.send(JSON.stringify({ type: 'terminal_resize', cols: term.cols, rows: term.rows }));
    }
  }).observe(document.getElementById('terminalContainer'));
  if (ws.readyState === WebSocket.OPEN) sendTerminalOpen();
}

function sendTerminalOpen() {
  if (!term || !fitAddon) return;
  fitAddon.fit();
  ws.send(JSON.stringify({ type: 'terminal_open', cols: term.cols, rows: term.rows }));
  term.focus();
}

ws.onopen = () => { if (termInitialized) sendTerminalOpen(); };

ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.type === 'peer_connected') {
    document.getElementById('dot').className = 'dot on';
    document.getElementById('statusText').textContent = 'Phone connected';
  } else if (d.type === 'peer_disconnected') {
    document.getElementById('dot').className = 'dot wait';
    document.getElementById('statusText').textContent = 'Phone disconnected';
  } else if (d.type === 'terminal_configured') {
    document.getElementById('launchText').textContent = 'Launch: ' + d.terminalLaunch;
  } else if (d.type === 'terminal_output' && term) {
    term.write(d.data);
  } else if (d.type === 'terminal_exit' && term) {
    const code = typeof d.exitCode === 'number' ? \`exit \${d.exitCode}\` : 'terminated';
    term.writeln(\`\r\n[terminal \${code}]\`);
  } else if (d.type === 'stream_chunk') {
    const msgs = document.getElementById('messages');
    if (msgs) {
      let last = msgs.lastElementChild;
      if (!last || last.dataset.streaming !== 'true') {
        last = document.createElement('div');
        last.className = 'msg assistant';
        last.dataset.streaming = 'true';
        msgs.appendChild(last);
      }
      last.textContent += d.data;
      msgs.scrollTop = msgs.scrollHeight;
    }
  } else if (d.type === 'stream_end') {
    const msgs = document.getElementById('messages');
    if (msgs?.lastElementChild) delete msgs.lastElementChild.dataset.streaming;
  } else if (d.type === 'message') {
    const msgs = document.getElementById('messages');
    if (msgs) {
      const el = document.createElement('div');
      el.className = \`msg \${d.role}\`;
      el.textContent = d.content;
      msgs.appendChild(el);
      msgs.scrollTop = msgs.scrollHeight;
    }
  }
};

fetch('/api/status').then(r => r.json()).then(d => {
  if (d.terminalLaunch) document.getElementById('launchText').textContent = 'Launch: ' + d.terminalLaunch;
  if (d.pairingCode) {
    document.getElementById('pairingCard').style.display = '';
    document.getElementById('pairingCode').textContent = d.pairingCode;
    if (d.pairingQR) document.getElementById('qrCode').src = d.pairingQR;
  }
  document.getElementById('dot').className = d.connected ? 'dot on' : 'dot wait';
  document.getElementById('statusText').textContent = d.connected ? 'Phone connected' : 'Waiting for phone...';
  if (d.adapter) {
    document.getElementById('chatSection').style.display = '';
    (d.messages || []).forEach(m => {
      const msgs = document.getElementById('messages');
      const el = document.createElement('div');
      el.className = \`msg \${m.role}\`;
      el.textContent = m.content;
      msgs.appendChild(el);
    });
  } else {
    document.getElementById('terminalSection').style.display = '';
    initTerminal();
  }
});

fetch('/api/cli-presets').then(r => r.json()).then(presets => {
  cliPresets = presets;
  const sel = document.getElementById('cliPreset');
  const shellOpt = document.createElement('option');
  shellOpt.value = 'shell'; shellOpt.textContent = 'Shell (default)';
  sel.appendChild(shellOpt);
  presets.forEach(p => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    const id = sel.value;
    const p = cliPresets.find(x => x.id === id);
    const cmd = document.getElementById('command');
    const desc = document.getElementById('presetDesc');
    if (id === 'shell') { cmd.style.display = 'none'; cmd.value = ''; desc.textContent = 'Interactive login shell.'; return; }
    if (id === 'custom') { cmd.style.display = ''; desc.textContent = 'Enter the exact launch command.'; return; }
    cmd.style.display = 'none';
    desc.textContent = p ? p.description : '';
  });
  sel.value = 'shell'; sel.dispatchEvent(new Event('change'));
  return fetch('/api/config').then(r => r.json());
}).then(cfg => {
  if (!cfg?.saved) return;
  const { saved } = cfg;
  if (saved.type === 'terminal' || saved.type === 'cli') {
    if (saved.preset) document.getElementById('cliPreset').value = saved.preset;
    if (saved.command) document.getElementById('command').value = saved.command;
    document.getElementById('cliPreset').dispatchEvent(new Event('change'));
  }
}).catch(() => {});

document.getElementById('applyLaunchBtn').addEventListener('click', async () => {
  const preset = document.getElementById('cliPreset').value;
  const command = document.getElementById('command').value;
  const r = await fetch('/api/configure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'cli', preset, command }) });
  const d = await r.json();
  if (d.error) alert(d.error);
});

document.getElementById('focusTermBtn').addEventListener('click', () => term?.focus());
document.getElementById('ctrlCBtn').addEventListener('click', () => {
  term?.focus();
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'terminal_input', data: '\x03' }));
});
document.getElementById('escBtn').addEventListener('click', () => {
  term?.focus();
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'terminal_input', data: '\x1b' }));
});
document.getElementById('tabBtn').addEventListener('click', () => {
  term?.focus();
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'terminal_input', data: '\t' }));
});

document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('messageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

function sendMessage() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if (!content) return;
  fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
    .then(() => { input.value = ''; })
    .catch(err => console.error('Failed to send:', err));
}
</script>
</body>
</html>`;
