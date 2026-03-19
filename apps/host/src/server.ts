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
import type { SavedConfig } from './config.js';

export interface ServerState {
  channel: Channel | null;
  adapter: AIAdapter | null;
  pairingCode: string;
  pairingQR: string;
  relayUrl: string;
  connected: boolean;
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
          const cmd = command || process.env.AIRLOOM_CLI_COMMAND;
          if (!cmd) { res.status(400).json({ error: 'CLI adapter requires a command (or set AIRLOOM_CLI_COMMAND env var)' }); return; }
          opts.state.adapter = new CLIAdapter({ command: cmd, model });
          break;
        }
        default: res.status(400).json({ error: 'Unknown adapter type' }); return;
      }
      // Persist selection (never saves API keys — those come from env vars or re-entry)
      const cfg: SavedConfig = { type };
      if (model) cfg.model = model;
      if (type === 'cli') { cfg.command = command; cfg.preset = preset; }
      saveConfig(cfg);
      broadcast({ type: 'configured', adapter: { name: opts.state.adapter.name, model: opts.state.adapter.model } });
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

  const batcher = new Batcher({
    interval: 100,
    onFlush: (data: string) => broadcast({ type: 'stream_chunk', data }),
  });

  const origWrite = stream.write.bind(stream);
  stream.write = (data: string) => { fullResponse += data; batcher.write(data); origWrite(data); };

  const origEnd = stream.end.bind(stream);
  stream.end = () => {
    batcher.flush();
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
    batcher.destroy();
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
  </div>
  <div class="card" id="configCard">
    <h2>AI Configuration</h2>
    <div class="config-form">
      <select id="adapterType"><option value="anthropic">Anthropic (Claude)</option><option value="openai">OpenAI (GPT)</option><option value="cli">CLI Tool</option></select>
      <input type="password" id="apiKey" placeholder="API Key"/>
      <input type="text" id="model" placeholder="Model (optional)"/>
      <div id="cliConfig" style="display:none">
        <select id="cliPreset" style="margin-bottom:8px"></select>
        <input type="text" id="command" placeholder="CLI command (prompt appended as last arg)"/>
        <p style="color:#666;font-size:.8rem;margin-top:4px" id="presetDesc"></p>
      </div>
      <button onclick="configure()">Configure</button>
    </div>
  </div>
  <div class="card pairing" id="pairingCard" style="display:none">
    <h2>Connect Your Phone</h2>
    <img id="qrCode" alt="QR Code"/>
    <div class="pairing-code" id="pairingCode"></div>
    <p style="color:#888;font-size:.85rem">Scan QR or enter code in viewer</p>
  </div>
  <div class="card" id="chatCard" style="display:none">
    <h2>Conversation</h2>
    <div class="messages" id="messages"></div>
    <div class="input-area">
      <textarea id="msgInput" placeholder="Type a message..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg()}"></textarea>
      <button onclick="sendMsg()">Send</button>
    </div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
<script>
if(typeof marked!=='undefined'){marked.setOptions({gfm:true,breaks:true})}
function renderMd(t){try{return typeof marked!=='undefined'?marked.parse(t):'<pre>'+t.replace(/</g,'&lt;')+'</pre>'}catch{return '<pre>'+t.replace(/</g,'&lt;')+'</pre>'}}
const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
let curResp='',streamEl=null,cliPresets=[];
// Load CLI presets
fetch('/api/cli-presets').then(r=>r.json()).then(presets=>{
  cliPresets=presets;
  const sel=document.getElementById('cliPreset');
  presets.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;sel.appendChild(o)});
  sel.addEventListener('change',()=>{
    const p=cliPresets.find(x=>x.id===sel.value);
    if(p){document.getElementById('command').value=p.command;document.getElementById('presetDesc').textContent=p.description;document.getElementById('command').style.display=p.id==='custom'?'':''}
  });
  if(presets.length){sel.dispatchEvent(new Event('change'))}
  // After presets are loaded, restore saved config
  return fetch('/api/config').then(r=>r.json());
}).then(cfg=>{
  if(!cfg) return;
  const {saved,envKeys}=cfg;
  if(saved){
    document.getElementById('adapterType').value=saved.type;
    document.getElementById('adapterType').dispatchEvent(new Event('change'));
    if(saved.model) document.getElementById('model').value=saved.model;
    if(saved.type==='cli'){
      if(saved.preset){document.getElementById('cliPreset').value=saved.preset;document.getElementById('cliPreset').dispatchEvent(new Event('change'))}
      if(saved.command) document.getElementById('command').value=saved.command;
    }
  }
  // Show hints for env-var API keys
  if(envKeys.anthropic) document.getElementById('apiKey').placeholder='API Key (ANTHROPIC_API_KEY set)';
  if(envKeys.openai&&(!saved||saved.type==='openai')) document.getElementById('apiKey').placeholder='API Key (OPENAI_API_KEY set)';
}).catch(()=>{});
document.getElementById('adapterType').addEventListener('change',e=>{
  const cli=e.target.value==='cli';
  document.getElementById('apiKey').style.display=cli?'none':'';
  document.getElementById('model').style.display=cli?'none':'';
  document.getElementById('cliConfig').style.display=cli?'':'none';
});
ws.onmessage=e=>{
  const d=JSON.parse(e.data);
  if(d.type==='message'){addMsg(d.role,d.content);if(d.role==='user'){streamEl=addMsg('assistant','');streamEl.classList.add('typing');streamEl.innerHTML='<span class="dot"></span><span class="dot"></span><span class="dot"></span>';curResp=''}}
  else if(d.type==='stream_chunk'){if(!streamEl){streamEl=addMsg('assistant','');streamEl.classList.add('typing');streamEl.innerHTML='<span class="dot"></span><span class="dot"></span><span class="dot"></span>'}curResp+=d.data;const trimmed=curResp.trimStart();if(trimmed){if(streamEl.classList.contains('typing'))streamEl.classList.remove('typing');streamEl.innerHTML=renderMd(trimmed)}streamEl.scrollIntoView({block:'end'})}
  else if(d.type==='stream_end'){streamEl=null;curResp=''}
  else if(d.type==='configured'){document.getElementById('statusText').textContent='Configured: '+d.adapter.name+' ('+d.adapter.model+')'}
  else if(d.type==='peer_connected'){document.getElementById('dot').className='dot on';document.getElementById('statusText').textContent='Phone connected';document.getElementById('chatCard').style.display=''}
  else if(d.type==='peer_disconnected'){document.getElementById('dot').className='dot wait';document.getElementById('statusText').textContent='Phone disconnected'}
};
fetch('/api/status').then(r=>r.json()).then(d=>{
  if(d.pairingCode){document.getElementById('pairingCard').style.display='';document.getElementById('pairingCode').textContent=d.pairingCode;if(d.pairingQR)document.getElementById('qrCode').src=d.pairingQR}
  if(d.connected){document.getElementById('dot').className='dot on';document.getElementById('statusText').textContent='Phone connected';document.getElementById('chatCard').style.display=''}
  else{document.getElementById('dot').className='dot wait';document.getElementById('statusText').textContent='Waiting for phone...'}
  if(d.adapter)document.getElementById('statusText').textContent+=' | '+d.adapter.name;
  if(d.messages)d.messages.forEach(m=>addMsg(m.role,m.content));
});
async function configure(){
  const r=await fetch('/api/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:document.getElementById('adapterType').value,apiKey:document.getElementById('apiKey').value,model:document.getElementById('model').value,command:document.getElementById('command').value,preset:document.getElementById('cliPreset').value})});
  const d=await r.json();if(d.error)alert(d.error);
}
async function sendMsg(){
  const el=document.getElementById('msgInput'),c=el.value.trim();if(!c)return;el.value='';
  await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:c})});
}
function addMsg(role,content){const el=document.createElement('div');el.className='msg '+role;if(role==='user'||!content){el.textContent=content}else{el.innerHTML=renderMd(content)}document.getElementById('messages').appendChild(el);el.scrollIntoView({block:'end'});return el}
</script>
</body>
</html>`;
