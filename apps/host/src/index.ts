import { Channel, WebSocketAdapter, AblyAdapter } from '@airloom/channel';
import type { RelayAdapter } from '@airloom/channel';
import { createSession, formatPairingCode, deriveEncryptionKey, deriveSessionToken, generateKeyPair } from '@airloom/crypto';
import { encodePairingData, randomCode, toBase64, type SessionRefreshMessage } from '@airloom/protocol';
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
import { parseHostEnv, isLoopbackBind } from './env.js';
import { loadOrCreateAblySessionToken } from './state.js';
import { createControlToken, encodeControlUrl } from './security.js';
import { handleStart, handleStop, handleList } from './daemon.js';
import { log, logError } from './log.js';

// Lazy import qrcode to avoid tsx ETIMEDOUT issues on macOS
let QRCode: typeof import('qrcode') | null = null;
async function getQRCode() {
  if (!QRCode) QRCode = await import('qrcode');
  return QRCode;
}

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
  airloom [options]            Start in foreground (default)
  airloom start [options]      Start as a background daemon
  airloom stop [name]          Stop a background session
  airloom stop --all           Stop all background sessions
  airloom list                 List running background sessions

Background options:
  --name <name>     Session name (default: "default").
                    Allows multiple independent sessions.

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
  HOST_PORT           Same as --port (default: 4000, auto-increments if in use).
  HOST_BIND           Host bind address (default: 127.0.0.1).
`.trimStart());
}

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
function resolveViewerDir(base: string): string | undefined {
  // Prod: dist/viewer/ alongside the bundled index.js
  const prod = resolve(base, 'viewer');
  if (existsSync(prod)) return prod;
  // Dev (tsx): src/ → ../../viewer/dist
  const dev = resolve(base, '../../viewer/dist');
  if (existsSync(dev)) return dev;
  return undefined;
}

async function main() {
  const cliArgs = parseArgs(process.argv);

  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }

  // Dev mode: running from local repo (not from npm/node_modules).
  // When true, the QR code points to the locally-served LAN viewer so the phone
  // uses the latest local build instead of the published GitHub Pages version.
  const IS_DEV = !process.env.VIEWER_URL && !new URL(import.meta.url).pathname.includes('node_modules');

  const env = parseHostEnv(cliArgs.port, IS_DEV);
  const VIEWER_URL = env.viewerUrl;
  const RELAY_URL = env.relayUrl;
  const ABLY_API_KEY = env.ablyApiKey;
  const ABLY_TOKEN_TTL = env.ablyTokenTtlMs;
  const HOST_PORT = env.hostPort;
  const HOST_BIND = env.hostBind;
  const useAbly = env.useAbly;
  const isDefaultKey = env.isDefaultAblyKey;
  const isDaemonChild = process.argv.includes('--_daemon');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  console.log('Airloom - Host');
  console.log('==============\n');

  if (useAbly) {
    if (isDefaultKey) {
      log('Transport: Ably (community relay — shared quota)');
      log('  Set ABLY_API_KEY for your own quota, or RELAY_URL for self-hosted.\n');
    } else {
      log('Transport: Ably (your key)');
    }
  } else {
    log(`Transport: WebSocket (self-hosted relay at ${RELAY_URL})`);
  }

  let pairingCode: string;
  let pairingSessionToken: string;
  let relaySessionToken: string;
  let pairingData: PairingData;
  let ablyToken: string | undefined;
  let ablyTokenExpiresAt: number | undefined;
  if (useAbly) {
    pairingCode = randomCode(8);
    pairingSessionToken = deriveSessionToken(pairingCode);
    relaySessionToken = loadOrCreateAblySessionToken();
    const keyPair = generateKeyPair();
    const { Rest } = await import('ably');
    const rest = new Rest({
      key: ABLY_API_KEY!,
      queryTime: true,
    });
    const channelName = `airloom:${relaySessionToken}`;
    const tokenDetails = await rest.auth.requestToken({
      clientId: '*',
      capability: { [channelName]: ['publish', 'subscribe', 'presence'] },
      ttl: ABLY_TOKEN_TTL,
    });
    log(`[ably] Scoped token issued (TTL: ${Math.round(ABLY_TOKEN_TTL / 60000)}min, channel: ${channelName})`);

    ablyToken = tokenDetails.token;
    ablyTokenExpiresAt = tokenDetails.expires;
    pairingData = {
      relay: 'ably',
      session: relaySessionToken,
      pub: toBase64(keyPair.publicKey),
      v: 1,
      transport: 'ably',
      token: ablyToken,
      tokenExpiresAt: ablyTokenExpiresAt,
    };
  } else {
    const session = createSession(RELAY_URL!);
    pairingCode = session.pairingCode;
    pairingSessionToken = session.sessionToken;
    relaySessionToken = session.sessionToken;
    pairingData = { ...session.pairingData };
  }
  const displayCode = formatPairingCode(pairingCode);
  const pairingJSON = encodePairingData(pairingData);

  const keyMaterial = sha256(new TextEncoder().encode('airloom-key:' + relaySessionToken));
  const encryptionKey = deriveEncryptionKey(keyMaterial);

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

  await channel.connect(relaySessionToken);
  log('[host] Connected to relay, waiting for phone...');

  const savedConfig = loadConfig();
  const launchPreset = cliArgs.preset ? CLI_PRESETS.find((p) => p.id === cliArgs.preset) : undefined;
  if (cliArgs.preset && !launchPreset) {
    logError(`[host] Unknown preset "${cliArgs.preset}". Available: ${CLI_PRESETS.map((p) => p.id).join(', ')}`);
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
    pairingSessionToken,
    relaySessionToken,
    ablyToken,
    ablyTokenExpiresAt,
    transport: useAbly ? 'ably' : 'ws',
  };

  log(`[host] Terminal launch: ${terminalLaunch}`);

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
      log(`[host] CLI adapter: ${command} (${presetInfo?.mode ?? 'oneshot'})`);
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
          log(`[host] Auto-configured: ${state.adapter.name} (${state.adapter.model})`);
          log(`  Loaded from ${getConfigPath()}`);
        }
      } catch (err) {
        logError('[host] Auto-configure failed:', (err as Error).message);
      }
    }
  }

  // Resolve viewer dist directory and start server
  const viewerDir = resolveViewerDir(__dirname);
  if (viewerDir) {
    log(`[host] Viewer files: ${viewerDir}`);
  } else {
    log('[host] Viewer dist not found — QR will open raw JSON fallback');
  }

  const controlToken = createControlToken();
  const { server, broadcast, port } = await createHostServer({
    port: HOST_PORT,
    bind: HOST_BIND,
    controlToken,
    state,
    viewerDir,
  });

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
  const lanViewerUrl = viewerDir && !isLoopbackBind(HOST_BIND) ? `${lanBaseUrl}/viewer/#${pairingBase64}` : null;

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

  // Use LAN IP for control URL when the server is accessible remotely
  const controlBase = isLoopbackBind(HOST_BIND) ? `http://localhost:${port}` : lanBaseUrl;
  const controlUrl = encodeControlUrl(controlBase, controlToken);
  console.log(`Host UI:    ${controlUrl}`);

  // Notify daemon parent that we're ready (IPC message)
  if (isDaemonChild && typeof process.send === 'function') {
    process.send({ type: 'ready', port, controlUrl, viewerUrl: qrTarget, pairingCode: displayCode });
  }

  // Auto-open browser unless running as daemon child or over SSH
  if (isDaemonChild) {
    // Daemon child — parent displays output to user
  } else if (env.isSSH) {
    if (isLoopbackBind(HOST_BIND)) {
      console.log('\n  (SSH session detected but server is bound to localhost — set HOST_BIND=0.0.0.0 to allow remote access)');
    } else {
      console.log('\n  (SSH session — open the Host UI URL above in a browser on your local machine)');
    }
  } else {
    import('node:child_process').then(({ execFile }) => {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execFile(cmd, [controlUrl]);
    }).catch(() => {});
  }
  console.log();

  const terminal = new TerminalSession(channel, () => state.terminalLaunchCommand, broadcast);
  state.terminal = terminal;
  const pushViewerSession = () => {
    if (!state.relaySessionToken || !state.transport) return;
    const refresh: SessionRefreshMessage = {
      type: 'session_refresh',
      relay: state.relayUrl,
      session: state.relaySessionToken,
      transport: state.transport,
      token: state.ablyToken,
      tokenExpiresAt: state.ablyTokenExpiresAt,
    };
    channel.send(refresh);
  };

  // Channel events
  channel.on('ready', () => {
    log('[host] Phone connected! Channel ready.');
    state.connected = true;
    broadcast({ type: 'peer_connected' });
    pushViewerSession();
  });

  channel.on('peer_left', () => {
    log('[host] Phone disconnected.');
    state.connected = false;
    terminal.detachStream();
    broadcast({ type: 'peer_disconnected' });
  });

  // Messages from the phone (viewer)
  channel.on('message', (data: unknown) => {
    if (isTerminalMessage(data)) {
      log('[host] Terminal message from phone:', (data as {type: string}).type);
      terminal.handleMessage(data);
      return;
    }
    if (typeof data === 'object' && data !== null && 'type' in data && 'content' in data) {
      const msg = data as Record<string, unknown>;
      if (msg.type === 'chat' && typeof msg.content === 'string') {
        log(`[phone] ${msg.content}`);
        state.messages.push({ role: 'user', content: msg.content, timestamp: Date.now() });
        broadcast({ type: 'message', role: 'user', content: msg.content });

        if (state.adapter) {
          enqueueAIResponse(channel, state.adapter, state, broadcast);
        }
      }
    }
  });

  channel.on('error', (err: Error) => logError('[host] Channel error:', err.message));

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('\n[host] Shutting down...');
    terminal.destroy();
    state.adapter?.destroy?.();
    try { channel.close(); } catch { /* Ably may throw if already detached */ }
    server.close(() => process.exit(0));
    // Force exit if server doesn't close within 1s
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------------------------------------------------------------------------
// Entry point — dispatch subcommands or run in foreground
// ---------------------------------------------------------------------------
const _cmd = process.argv[2];

if (_cmd === 'start' || _cmd === 'stop' || _cmd === 'list') {
  (async () => {
    const _args = process.argv.slice(3);

    if (_cmd === 'list') {
      handleList();
      return;
    }

    if (_cmd === 'stop') {
      let stopName: string | null = null;
      let stopAll = false;
      for (const a of _args) {
        if (a === '--all') stopAll = true;
        else if (!a.startsWith('-')) stopName = a;
      }
      handleStop(stopName, stopAll);
      return;
    }

    // start — parse --name, forward remaining args to child
    let startName = 'default';
    const hostArgs: string[] = [];
    for (let i = 0; i < _args.length; i++) {
      const a = _args[i];
      if (a === '--name' && i + 1 < _args.length) { startName = _args[++i]; }
      else if (a.startsWith('--name=')) { startName = a.slice(7); }
      else { hostArgs.push(a); }
    }
    await handleStart(startName, hostArgs);
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    logError('Fatal error:', err);
    process.exit(1);
  });
}
