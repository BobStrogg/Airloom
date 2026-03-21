import { Channel, WebSocketAdapter, AblyAdapter } from '@airloom/channel';
import type { RelayAdapter } from '@airloom/channel';
import { createSession, formatPairingCode, deriveEncryptionKey } from '@airloom/crypto';
import { encodePairingData } from '@airloom/protocol';
import type { PairingData } from '@airloom/protocol';
import { sha256 } from '@noble/hashes/sha256';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHostServer, enqueueAIResponse } from './server.js';
import type { ServerState } from './server.js';
import { loadConfig, getConfigPath } from './config.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { CLIAdapter, CLI_PRESETS } from './adapters/cli.js';
import { TerminalSession, getTerminalLaunchDisplay, isTerminalMessage } from './terminal.js';

// Lazy import qrcode to avoid tsx ETIMEDOUT issues on macOS
let QRCode: typeof import('qrcode') | null = null;
async function getQRCode() {
  if (!QRCode) QRCode = await import('qrcode');
  return QRCode;
}

console.log('[host] Module loaded');

// ---------------------------------------------------------------------------
// CLI argument parsing (lightweight, no dependencies)
// ---------------------------------------------------------------------------
interface CliArgs {
  cli?: string;     // --cli "devin -p --"
  preset?: string;  // --preset devin
  port?: number;    // --port 3000
  help?: boolean;   // --help / -h
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const rest = argv.slice(2); // skip node + script
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--help' || a === '-h') { args.help = true; }
    else if (a === '--cli' && i + 1 < rest.length) { args.cli = rest[++i]; }
    else if (a === '--preset' && i + 1 < rest.length) { args.preset = rest[++i]; }
    else if (a === '--port' && i + 1 < rest.length) { args.port = parseInt(rest[++i], 10); }
    else if (a.startsWith('--cli=')) { args.cli = a.slice(6); }
    else if (a.startsWith('--preset=')) { args.preset = a.slice(9); }
    else if (a.startsWith('--port=')) { args.port = parseInt(a.slice(7), 10); }
  }
  return args;
}

function printHelp() {
  const presetList = CLI_PRESETS.filter((p) => p.id !== 'custom')
    .map((p) => `    ${p.id.padEnd(14)} ${p.command}`)
    .join('\n');
  console.log(`
Airloom — Run AI on your computer, control it from your phone.

Usage:
  airloom [options]

Options:
  --cli <command>     CLI command to use as the AI adapter.
                      The user's message is appended as the last argument.
                      Example: airloom --cli "devin -p --"

  --preset <name>     Use a built-in CLI preset instead of --cli.
                      Available presets:
${presetList}

  --port <number>     Port for the host web UI (default: auto-select).

  -h, --help          Show this help message.

Environment variables:
  ANTHROPIC_API_KEY   API key for the Anthropic adapter.
  OPENAI_API_KEY      API key for the OpenAI adapter.
  ABLY_API_KEY        Your own Ably key (overrides default community relay).
  RELAY_URL           Self-hosted WebSocket relay URL (disables Ably).
  VIEWER_URL          Public viewer URL (default: GitHub Pages).
  HOST_PORT           Same as --port (CLI flag takes precedence).
`.trimStart());
}

const cliArgs = parseArgs(process.argv);

if (cliArgs.help) {
  printHelp();
  process.exit(0);
}

// Default community relay key — restricted to airloom:* channels (publish/subscribe/presence only).
// Users can override with ABLY_API_KEY for their own quota, or set RELAY_URL for self-hosted WS.
const DEFAULT_ABLY_KEY = 'SfHSAQ.IRTOQQ:FBbi9a7ZV6jIu0Gdo_UeYhIN4rzpMrud5-LldURNh9s';

// Public viewer URL (GitHub Pages). Pairing data goes in the hash fragment,
// which is never sent to the server — only the browser sees it.
const DEFAULT_VIEWER_URL = 'https://bobstrogg.github.io/Airloom/';
const VIEWER_URL = process.env.VIEWER_URL ?? DEFAULT_VIEWER_URL;

// Dev mode: running from local repo (not from npm/node_modules).
// When true, the QR code points to the locally-served LAN viewer so the phone
// uses the latest local build instead of the published GitHub Pages version.
const IS_DEV = !process.env.VIEWER_URL && !new URL(import.meta.url).pathname.includes('node_modules');

const RELAY_URL = process.env.RELAY_URL;
const ABLY_API_KEY = process.env.ABLY_API_KEY ?? (RELAY_URL ? undefined : DEFAULT_ABLY_KEY);
const ABLY_TOKEN_TTL = parseInt(process.env.ABLY_TOKEN_TTL ?? String(24 * 60 * 60 * 1000), 10); // default 24h
const HOST_PORT = cliArgs.port ?? parseInt(process.env.HOST_PORT ?? '0', 10); // 0 = auto-select free port

// Use Ably unless RELAY_URL is explicitly set
const useAbly = !!ABLY_API_KEY;
const isDefaultKey = useAbly && ABLY_API_KEY === DEFAULT_ABLY_KEY;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Find the first non-internal IPv4 LAN address. */
function getLanIP(): string | undefined {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return undefined;
}

/** Resolve the viewer dist directory (works in both dev and prod layout). */
function resolveViewerDir(): string | undefined {
  // Prod: dist/viewer/ alongside the bundled index.js
  const prod = resolve(__dirname, 'viewer');
  if (existsSync(prod)) return prod;
  // Dev (tsx): src/ → ../../viewer/dist
  const dev = resolve(__dirname, '../../viewer/dist');
  if (existsSync(dev)) return dev;
  return undefined;
}

async function main() {
  console.log('Airloom - Host');
  console.log('==============\n');

  if (useAbly) {
    if (isDefaultKey) {
      console.log('Transport: Ably (community relay — shared quota)');
      console.log('  Set ABLY_API_KEY for your own quota, or RELAY_URL for self-hosted.\n');
    } else {
      console.log('Transport: Ably (your key)');
    }
  } else {
    console.log(`Transport: WebSocket (self-hosted relay at ${RELAY_URL})`);
  }

  // Create session with keypair and pairing code
  const session = createSession(useAbly ? 'ably' : RELAY_URL!);
  const displayCode = formatPairingCode(session.pairingCode);

  // Build pairing data
  let pairingData: PairingData;
  if (useAbly) {
    // Mint a scoped, time-limited token for the viewer using Ably REST API.
    // The API key (default or custom) never leaves the host.
    const { Rest } = await import('ably');
    const rest = new Rest({
      key: ABLY_API_KEY!,
      queryTime: true,
    });
    const channelName = `airloom:${session.sessionToken}`;
    const tokenDetails = await rest.auth.requestToken({
      clientId: '*', // viewer picks its own clientId
      capability: { [channelName]: ['publish', 'subscribe', 'presence'] },
      ttl: ABLY_TOKEN_TTL,
    });
    console.log(`[ably] Scoped token issued (TTL: ${Math.round(ABLY_TOKEN_TTL / 60000)}min, channel: ${channelName})`);

    pairingData = {
      ...session.pairingData,
      transport: 'ably',
      token: tokenDetails.token,
    };
  } else {
    pairingData = { ...session.pairingData };
  }
  const pairingJSON = encodePairingData(pairingData);

  // Derive encryption key from session token (both sides do this identically)
  const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + session.sessionToken));
  const encryptionKey = deriveEncryptionKey(keyMaterial);

  // Create adapter based on transport
  let adapter: RelayAdapter;
  if (useAbly) {
    adapter = new AblyAdapter({ key: ABLY_API_KEY! });
  } else {
    adapter = new WebSocketAdapter(RELAY_URL!);
  }

  const channel = new Channel({
    adapter,
    role: 'host',
    encryptionKey,
  });

  // Connect to relay
  await channel.connect(session.sessionToken);
  console.log('[host] Connected to relay, waiting for phone...');

  const savedConfig = loadConfig();
  const launchPreset = cliArgs.preset ? CLI_PRESETS.find((p) => p.id === cliArgs.preset) : undefined;
  if (cliArgs.preset && !launchPreset) {
    console.error(`[host] Unknown preset "${cliArgs.preset}". Available: ${CLI_PRESETS.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }
  const savedTerminalCommand = (!cliArgs.cli && !cliArgs.preset && savedConfig?.type === 'terminal')
    ? (savedConfig.command ?? (savedConfig.preset && savedConfig.preset !== 'shell'
      ? CLI_PRESETS.find((p) => p.id === savedConfig.preset)?.command
      : undefined))
    : undefined;
  const launchCommand = cliArgs.cli ?? launchPreset?.command ?? savedTerminalCommand;
  const terminalLaunch = getTerminalLaunchDisplay(launchCommand);

  const state: ServerState = {
    channel,
    adapter: null,
    pairingCode: displayCode,
    pairingQR: '', // set after server starts
    relayUrl: useAbly ? 'ably' : RELAY_URL!,
    connected: false,
    terminalLaunch,
    terminalLaunchCommand: launchCommand,
    messages: [],
    sessionToken: session.sessionToken,
    ablyToken: useAbly ? (pairingData as { token?: string }).token : undefined,
    transport: useAbly ? 'ably' : 'ws',
  };

  console.log(`[host] Terminal launch: ${terminalLaunch}`);

  // Configure adapter: CLI args take precedence, then saved config, then env vars.
  if (cliArgs.cli || cliArgs.preset) {
    // --cli or --preset provided on the command line
    let command = cliArgs.cli;
    const presetInfo = launchPreset;
    if (presetInfo && !command) command = presetInfo.command;
    if (command) {
      state.adapter = new CLIAdapter({
        command,
        mode: presetInfo?.mode,
        silenceTimeout: presetInfo?.silenceTimeout,
      });
      console.log(`[host] CLI adapter: ${command} (${presetInfo?.mode ?? 'oneshot'})`);
    }
  } else {
    // Fall back to saved config file
    const saved = loadConfig();
    if (saved) {
      try {
        switch (saved.type) {
          case 'anthropic': {
            const key = process.env.ANTHROPIC_API_KEY;
            if (key) { state.adapter = new AnthropicAdapter({ apiKey: key, model: saved.model }); }
            break;
          }
          case 'openai': {
            const key = process.env.OPENAI_API_KEY;
            if (key) { state.adapter = new OpenAIAdapter({ apiKey: key, model: saved.model }); }
            break;
          }
          case 'cli': {
            const cmd = saved.command || process.env.AIRLOOM_CLI_COMMAND;
            const savedPreset = saved.preset ? CLI_PRESETS.find((p) => p.id === saved.preset) : undefined;
            if (cmd) {
              state.adapter = new CLIAdapter({
                command: cmd, model: saved.model,
                mode: savedPreset?.mode,
                silenceTimeout: savedPreset?.silenceTimeout,
              });
            }
            break;
          }
        }
        if (state.adapter) {
          console.log(`[host] Auto-configured: ${state.adapter.name} (${state.adapter.model})`);
          console.log(`  Loaded from ${getConfigPath()}`);
        }
      } catch (err) {
        console.error('[host] Auto-configure failed:', (err as Error).message);
      }
    }
  }

  // Resolve viewer dist directory and start server
  const viewerDir = resolveViewerDir();
  if (viewerDir) {
    console.log(`[host] Viewer files: ${viewerDir}`);
  } else {
    console.log('[host] Viewer dist not found — QR will open raw JSON fallback');
  }

  const { server, broadcast, port } = await createHostServer({ port: HOST_PORT, state, viewerDir });

  // Build the QR content — a URL that opens the viewer on the phone.
  // In dev mode (running from source), the QR points to the locally-served LAN
  // viewer so the phone always uses the latest local build. In production the
  // QR points to GitHub Pages so the phone doesn't need LAN access.
  const pairingBase64 = Buffer.from(pairingJSON).toString('base64url');
  const viewerBase = VIEWER_URL.replace(/\/+$/, '');
  const pagesUrl = `${viewerBase}/#${pairingBase64}`;

  const lanIP = getLanIP();
  const lanHost = lanIP ?? 'localhost';
  const lanBaseUrl = `http://${lanHost}:${port}`;
  const lanViewerUrl = viewerDir ? `${lanBaseUrl}/viewer/#${pairingBase64}` : null;

  // Dev mode uses LAN viewer; production uses GitHub Pages
  const qrTarget = (IS_DEV && lanViewerUrl) ? lanViewerUrl : pagesUrl;

  const qrcode = await getQRCode();
  const qrDataUrl = await qrcode.toDataURL(qrTarget, { width: 300, margin: 2 });
  const qrTerminal = await qrcode.toString(qrTarget, { type: 'terminal', small: true });
  state.pairingQR = qrDataUrl;

  console.log('\nPairing QR Code:');
  console.log(qrTerminal);
  console.log(`Pairing Code: ${displayCode}`);
  if (IS_DEV && lanViewerUrl) {
    console.log(`Viewer URL (LAN/dev): ${lanViewerUrl}`);
    console.log(`Pages URL:            ${pagesUrl}`);
  } else {
    console.log(`Viewer URL: ${pagesUrl}`);
    if (lanViewerUrl) console.log(`LAN Viewer:  ${lanViewerUrl}`);
  }
  if (!useAbly) console.log(`Relay: ${RELAY_URL}`);

  const localUrl = `http://localhost:${port}`;
  console.log(`[host] Web UI at ${localUrl}\n`);

  // Auto-open browser so the phone can scan a proper QR image
  import('node:child_process').then(({ exec }) => {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} ${localUrl}`);
  }).catch(() => {});

  const terminal = new TerminalSession(channel, () => state.terminalLaunchCommand, broadcast);
  state.terminal = terminal;

  // Channel events
  channel.on('ready', () => {
    console.log('[host] Phone connected! Channel ready.');
    state.connected = true;
    broadcast({ type: 'peer_connected' });
  });

  channel.on('peer_left', () => {
    console.log('[host] Phone disconnected.');
    state.connected = false;
    terminal.close();
    broadcast({ type: 'peer_disconnected' });
  });

  // Messages from the phone (viewer)
  channel.on('message', (data: unknown) => {
    if (isTerminalMessage(data)) {
      terminal.handleMessage(data);
      return;
    }
    if (typeof data === 'object' && data !== null && 'type' in data && 'content' in data) {
      const msg = data as Record<string, unknown>;
      if (msg.type === 'chat' && typeof msg.content === 'string') {
        console.log(`[phone] ${msg.content}`);
        state.messages.push({ role: 'user', content: msg.content, timestamp: Date.now() });
        broadcast({ type: 'message', role: 'user', content: msg.content });

        if (state.adapter) {
          enqueueAIResponse(channel, state.adapter, state, broadcast);
        }
      }
    }
  });

  channel.on('error', (err: Error) => console.error('[host] Channel error:', err.message));

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[host] Shutting down...');
    terminal.close();
    state.adapter?.destroy?.();
    try { channel.close(); } catch { /* Ably may throw if already detached */ }
    server.close(() => process.exit(0));
    // Force exit if server doesn't close within 1s
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
