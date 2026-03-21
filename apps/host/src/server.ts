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

  wss.on('connection', (ws) => {
    uiClients.add(ws);
    ws.on('close', () => uiClients.delete(ws));
    
    // Handle messages from the web UI
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Route terminal messages to the terminal session
        if (message.type && message.type.startsWith('terminal_')) {
          // Forward to the channel if connected (for phone viewer)
          if (opts.state.channel) {
            opts.state.channel.send(message);
          }
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
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh}
  .container{max-width:800px;margin:0 auto;padding:20px}
  .page-header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
  .page-header svg{width:36px;height:36px;flex-shrink:0}
  .page-header h1{font-size:1.5rem;color:#7c8aff}
  h2{font-size:1.1rem;margin-bottom:12px;color:#a0a0a0}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:16px}
  .status{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .dot{width:8px;height:8px;border-radius:50%}
  .dot.on{background:#4caf50} .dot.off{background:#f44336} .dot.wait{background:#ff9800;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .pairing{text-align:center}
  .pairing img{max-width:200px;margin:16px auto;display:block;border-radius:8px}
  .pairing-code{font-family:monospace;font-size:2rem;letter-spacing:4px;color:#7c8aff;margin:12px 0}
  .config-form{display:flex;flex-direction:column;gap:12px}
  select,input,button{padding:10px 14px;border-radius:8px;border:1px solid #333;background:#111;color:#e0e0e0;font-size:.95rem}
  select:focus,input:focus{outline:none;border-color:#7c8aff}
  button{background:#7c8aff;color:#fff;border:none;cursor:pointer;font-weight:600}
  button:hover{background:#6b79ee}
  .messages{max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
  .msg{padding:10px 14px;border-radius:10px;max-width:85%;word-break:break-word;font-size:.9rem;line-height:1.5}
  .msg.user{background:#2a3a6a;align-self:flex-end;white-space:pre-wrap}
  .msg.assistant{background:#1e1e1e;border:1px solid #2a2a2a;align-self:flex-start}
  .msg.assistant p{margin:0 0 .5em}.msg.assistant p:last-child{margin-bottom:0}
  .msg.assistant h1,.msg.assistant h2,.msg.assistant h3,.msg.assistant h4,.msg.assistant h5,.msg.assistant h6{font-size:.95rem;font-weight:600;margin:.6em 0 .3em;color:#e0e0e0}
  .msg.assistant h1{font-size:1.05rem}.msg.assistant h2{font-size:1rem}
  .msg.assistant ul,.msg.assistant ol{margin:.3em 0;padding-left:1.4em}.msg.assistant li{margin:.15em 0}
  .msg.assistant a{color:#7c8aff;text-decoration:underline}
  .msg.assistant code{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.82rem;background:rgba(255,255,255,.07);padding:1px 5px;border-radius:4px}
  .msg.assistant pre{margin:.5em 0;padding:10px 12px;border-radius:8px;background:#111;overflow-x:auto}
  .msg.assistant pre code{background:none;padding:0;font-size:.8rem;line-height:1.5;white-space:pre;display:block}
  .msg.assistant blockquote{margin:.4em 0;padding:4px 12px;border-left:3px solid #2a2a2a;color:#888}
  .msg.assistant table{border-collapse:collapse;margin:.4em 0;font-size:.82rem}
  .msg.assistant th,.msg.assistant td{border:1px solid #2a2a2a;padding:4px 8px}
  .msg.assistant th{background:rgba(255,255,255,.05)}
  .msg.assistant hr{border:none;border-top:1px solid #2a2a2a;margin:.5em 0}
  .msg.typing{display:flex;align-items:center;gap:5px;padding:14px 18px}
  .msg.typing .dot{width:7px;height:7px;border-radius:50%;background:#888;animation:dot-pulse 1.4s ease-in-out infinite}
  .msg.typing .dot:nth-child(2){animation-delay:.2s}
  .msg.typing .dot:nth-child(3){animation-delay:.4s}
  @keyframes dot-pulse{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
  .input-area{display:flex;gap:8px}
  .input-area textarea{flex:1;resize:none;min-height:44px;max-height:120px;padding:10px 14px;border-radius:8px;border:1px solid #333;background:#111;color:#e0e0e0;font-family:inherit;font-size:.9rem}
  
  /* Terminal mode styles */
  .terminal-mode .chat-only { display: none !important; }
  .terminal-mode .terminal-only { display: block; }
  .chat-mode .terminal-only { display: none !important; }
  .chat-mode .chat-only { display: block; }
  
  .terminal-container{background:#05070c;border:1px solid #2a2a2a;border-radius:8px;height:400px;overflow:hidden;margin-bottom:12px}
  #terminal{width:100%;height:100%;padding:8px}
  .terminal-toolbar{display:flex;gap:8px;margin-bottom:12px}
  .tool-btn{padding:6px 12px;font-size:.85rem;background:#333;border:none;border-radius:6px;color:#e0e0e0;cursor:pointer}
  .tool-btn:hover{background:#444}
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
    <p style="color:#888;font-size:.9rem;margin-top:8px" id="launchText">Launch: current shell</p>
  </div>
  
  <!-- Chat mode UI -->
  <div id="chatMode" class="chat-mode">
    <div class="card" id="configCard">
      <h2>AI Configuration</h2>
      <div class="config-form">
        <select id="adapterType">
          <option value="anthropic">Anthropic Claude</option>
          <option value="openai">OpenAI GPT</option>
          <option value="cli">CLI Adapter</option>
        </select>
        <input type="text" id="model" placeholder="Model (optional)" />
        <input type="text" id="apiKey" placeholder="API Key (if not set in environment)" />
        <button onclick="configureAdapter()">Configure Adapter</button>
      </div>
    </div>
    
    <div class="card chat-only" id="chatCard" style="display:none">
      <h2>Chat Messages</h2>
      <div class="messages" id="messages"></div>
      <div class="input-area chat-only">
        <textarea id="messageInput" placeholder="Type your message..." rows="1"></textarea>
        <button onclick="sendMessage()">Send</button>
      </div>
    </div>
  </div>
  
  <!-- Terminal mode UI -->
  <div id="terminalMode" class="terminal-mode" style="display:none">
    <div class="card">
      <h2>Terminal Configuration</h2>
      <div class="config-form">
        <select id="cliPreset"></select>
        <input type="text" id="command" placeholder="Custom launch command" style="display:none"/>
        <p style="color:#666;font-size:.8rem;margin-top:4px" id="presetDesc"></p>
        <button onclick="configureTerminal()">Apply Launch Target</button>
      </div>
    </div>
    
    <div class="card terminal-only">
      <h2>Terminal Session</h2>
      <div class="terminal-toolbar terminal-only">
        <button class="tool-btn" onclick="focusTerminal()">Focus</button>
        <button class="tool-btn" onclick="sendCtrlC()">Ctrl+C</button>
        <button class="tool-btn" onclick="sendEsc()">Esc</button>
        <button class="tool-btn" onclick="sendTab()">Tab</button>
      </div>
      <div class="terminal-container terminal-only" id="terminalContainer">
        <div id="terminal"></div>
      </div>
    </div>
  </div>
  
  <div class="card pairing" id="pairingCard" style="display:none">
    <h2>Connect Your Phone</h2>
    <img id="qrCode" alt="QR Code"/>
    <div class="pairing-code" id="pairingCode"></div>
    <p style="color:#888;font-size:.85rem">Scan QR or enter code in viewer</p>
  </div>
</div>
<script>
// Import xterm dynamically to avoid bundling issues
const loadTerminal = async () => {
  if (window.Terminal) return;
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit')
  ]);
  window.Terminal = Terminal;
  window.FitAddon = FitAddon;
};

const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
let cliPresets=[];
let currentMode = null; // 'chat' or 'terminal'
let term = null;
let fitAddon = null;

// Mode detection and UI switching
function switchToMode(mode) {
  if (currentMode === mode) return;
  currentMode = mode;
  
  const chatMode = document.getElementById('chatMode');
  const terminalMode = document.getElementById('terminalMode');
  
  if (mode === 'terminal') {
    chatMode.style.display = 'none';
    terminalMode.style.display = 'block';
    document.body.classList.add('terminal-mode');
    document.body.classList.remove('chat-mode');
    initTerminal();
  } else {
    chatMode.style.display = 'block';
    terminalMode.style.display = 'none';
    document.body.classList.add('chat-mode');
    document.body.classList.remove('terminal-mode');
  }
}

// Terminal functionality
async function initTerminal() {
  if (term) return;
  await loadTerminal();
  
  term = new window.Terminal({
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
  
  fitAddon = new window.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'terminal_input', data }));
    }
  });
  
  // Handle terminal resize
  const resizeObserver = new ResizeObserver(() => {
    if (fitAddon && term) {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
          type: 'terminal_resize', 
          cols: term.cols, 
          rows: term.rows 
        }));
      }
    }
  });
  resizeObserver.observe(document.getElementById('terminalContainer'));
  
  // Auto-focus terminal
  term.focus();
}

function focusTerminal() {
  if (term) term.focus();
}

function sendCtrlC() {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'terminal_input', data: '\x03' }));
  }
  if (term) term.focus();
}

function sendEsc() {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'terminal_input', data: '\x1b' }));
  }
  if (term) term.focus();
}

function sendTab() {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'terminal_input', data: '\t' }));
  }
  if (term) term.focus();
}

// Load CLI presets for terminal mode
fetch('/api/cli-presets').then(r=>r.json()).then(presets=>{
  cliPresets=presets;
  const sel=document.getElementById('cliPreset');
  const shellOpt=document.createElement('option');
  shellOpt.value='shell';
  shellOpt.textContent='Shell (default)';
  sel.appendChild(shellOpt);
  presets.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;sel.appendChild(o)});
  sel.addEventListener('change',()=>{
    const id=sel.value;
    const p=cliPresets.find(x=>x.id===id);
    const cmd=document.getElementById('command');
    if(id==='shell'){cmd.style.display='none';cmd.value='';document.getElementById('presetDesc').textContent='Start an interactive login shell. Run commands directly in the phone terminal.';return;}
    if(id==='custom'){cmd.style.display='';document.getElementById('presetDesc').textContent='Enter the exact launch command.';return;}
    cmd.style.display='none';
    document.getElementById('presetDesc').textContent=p?p.description:'';
  });
  sel.value='shell';
  sel.dispatchEvent(new Event('change'));
  return fetch('/api/config').then(r=>r.json());
}).then(cfg=>{
  if(!cfg) return;
  const {saved}=cfg;
  if(saved && (saved.type==='terminal' || saved.type==='cli')){
    if(saved.preset) document.getElementById('cliPreset').value=saved.preset;
    if(saved.command) document.getElementById('command').value=saved.command;
    document.getElementById('cliPreset').dispatchEvent(new Event('change'));
  }
}).catch(()=>{});

// WebSocket message handling
ws.onmessage=e=>{
  const d=JSON.parse(e.data);
  if(d.type==='peer_connected'){
    document.getElementById('dot').className='dot on';
    document.getElementById('statusText').textContent='Phone connected';
  }
  else if(d.type==='peer_disconnected'){
    document.getElementById('dot').className='dot wait';
    document.getElementById('statusText').textContent='Phone disconnected';
  }
  else if(d.type==='terminal_configured'){
    document.getElementById('launchText').textContent='Launch: '+d.terminalLaunch;
    document.getElementById('statusText').textContent='Launch target updated';
  }
  else if(d.type==='configured'){
    document.getElementById('statusText').textContent='AI adapter configured';
  }
  else if(d.type==='stream_chunk' && term){
    term.write(d.data);
  }
  else if(d.type==='stream_end' && term){
    // Terminal stream ended
  }
  else if(d.type==='terminal_exit' && term){
    const detail = typeof d.exitCode === 'number' ? \`exit \${d.exitCode}\` : 'terminated';
    term.writeln(\`\r\n[terminal \${detail}]\`);
  }
  else if(d.type==='message'){
    // Chat message - add to chat UI
    const messagesDiv = document.getElementById('messages');
    if (messagesDiv) {
      const msgDiv = document.createElement('div');
      msgDiv.className = \`msg \${d.role}\`;
      msgDiv.textContent = d.content;
      messagesDiv.appendChild(msgDiv);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  }
};

// Load initial status and determine mode
fetch('/api/status').then(r=>r.json()).then(d=>{
  if(d.terminalLaunch) document.getElementById('launchText').textContent='Launch: '+d.terminalLaunch;
  if(d.pairingCode){
    document.getElementById('pairingCard').style.display='';
    document.getElementById('pairingCode').textContent=d.pairingCode;
    if(d.pairingQR) document.getElementById('qrCode').src=d.pairingQR;
  }
  if(d.connected){
    document.getElementById('dot').className='dot on';
    document.getElementById('statusText').textContent='Phone connected';
  } else{
    document.getElementById('dot').className='dot wait';
    document.getElementById('statusText').textContent='Waiting for phone...';
  }
  
  // Determine mode: terminal mode if no adapter but has terminal launch
  if (!d.adapter && d.terminalLaunch) {
    switchToMode('terminal');
  } else {
    switchToMode('chat');
    if (d.adapter) {
      document.getElementById('chatCard').style.display = 'block';
    }
  }
});

// Configuration functions
async function configureAdapter() {
  const type = document.getElementById('adapterType').value;
  const model = document.getElementById('model').value;
  const apiKey = document.getElementById('apiKey').value;
  
  const response = await fetch('/api/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, model, apiKey })
  });
  const result = await response.json();
  if (result.error) {
    alert(result.error);
  } else {
    document.getElementById('chatCard').style.display = 'block';
  }
}

async function configureTerminal() {
  const preset = document.getElementById('cliPreset').value;
  const command = document.getElementById('command').value;
  
  const response = await fetch('/api/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'cli', preset, command })
  });
  const result = await response.json();
  if (result.error) {
    alert(result.error);
  }
}

// Chat functionality
function sendMessage() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if (!content) return;
  
  fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }).then(() => {
    input.value = '';
  }).catch(err => {
    console.error('Failed to send message:', err);
  });
}

// Handle Enter key in chat input
document.getElementById('messageInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
</script>
</body>
</html>`;
