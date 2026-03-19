# Airloom

Run AI on your computer, control it from your phone. End-to-end encrypted WebSocket relay (self-hosted) or Ably (managed) connects the two.

## Architecture

```
Phone (Viewer)  <--E2E encrypted-->  Relay  <--E2E encrypted-->  Computer (Host)
                                   (WS or Ably)
```

- **Host** (`apps/host`) — Node.js process on your computer. Runs AI adapters (Anthropic, OpenAI, CLI) and exposes a local web UI at `http://localhost:3000`.
- **Viewer** (`apps/viewer`) — Browser app for your phone. Connects via QR scan or 8-character pairing code.
- **Relay** (`packages/relay`) — Self-hosted WebSocket relay server. Optional if using Ably.
- **Channel** (`packages/channel`) — Encrypted channel abstraction over any transport.
- **Protocol** (`packages/protocol`) — Message types, codecs, pairing data format.
- **Crypto** (`packages/crypto`) — Key derivation, encryption (ChaCha20-Poly1305 via @noble/ciphers).

## Prerequisites

- Node.js >= 18
- pnpm >= 8

## Install

```bash
pnpm install
```

## Running

### Quick start (no config needed)

```bash
pnpm --filter @airloom/host dev
```

That's it. Airloom ships with a built-in community relay via Ably — no server to run, no API keys to configure. A QR code and pairing code will appear in your terminal.

For the viewer, build and serve the static files, then open on your phone:

```bash
pnpm --filter @airloom/viewer build
npx serve apps/viewer/dist
```

The community relay uses a shared Ably quota. For heavier use, set `ABLY_API_KEY` with your own key (free at https://ably.com), or set `RELAY_URL` for a self-hosted WebSocket relay.

### Self-hosted relay (WebSocket)

Set `RELAY_URL` to switch to a self-hosted WebSocket relay:

1. Start the relay server:
   ```bash
   pnpm --filter @airloom/relay start
   # Listens on ws://localhost:4500
   ```

2. Start the host (in another terminal):
   ```bash
   RELAY_URL=ws://localhost:4500 pnpm --filter @airloom/host dev
   ```

### Bring your own Ably key

Create a key in the Ably dashboard scoped to `airloom:*` with publish/subscribe/presence, then:

```bash
ABLY_API_KEY="your-key" pnpm --filter @airloom/host dev
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `RELAY_URL` | — | WebSocket relay URL. When set, disables Ably and uses self-hosted relay |
| `ABLY_API_KEY` | built-in community key | Your own Ably key. Overrides the shared community relay |
| `ABLY_TOKEN_TTL` | `86400000` (24h) | Viewer token lifetime in ms. Session expires when token does |
| `HOST_PORT` | `3000` | Local web UI port |
| `ANTHROPIC_API_KEY` | — | Anthropic API key for Claude |
| `OPENAI_API_KEY` | — | OpenAI API key for GPT |
| `AIRLOOM_CLI_COMMAND` | — | Shell command for CLI adapter |
| `AI_ADAPTER` | — | Adapter type: `anthropic`, `openai`, or `cli` |
| `AI_MODEL` | — | Model name override |

## Development

```bash
# Typecheck everything
pnpm typecheck

# Build viewer
pnpm --filter @airloom/viewer build

# Build host
pnpm --filter @airloom/host build
```

## Security

All messages between host and viewer are end-to-end encrypted with ChaCha20-Poly1305. The relay (whether self-hosted WebSocket or Ably) only sees opaque ciphertext. The encryption key is derived from the pairing code using HKDF-SHA256 — it never leaves the two endpoints.

### Ably Token Auth

When using Ably (default or custom key), the host mints a **scoped token** via `rest.auth.requestToken()`. This token:

- Is restricted to a single Ably channel (`airloom:{sessionToken}`) — the viewer cannot access any other channel
- Has publish, subscribe, and presence permissions only
- Expires after a configurable TTL (default 24 hours, set via `ABLY_TOKEN_TTL`)
- Uses `clientId: '*'` so the viewer can set its own identity for presence

The API key **never** appears in the QR code or leaves the host process. If a token is intercepted, the attacker gains access to only one session's Ably channel — and all payloads on that channel are E2E encrypted anyway.

The built-in community key is further restricted to `airloom:*` channel names with only publish/subscribe/presence capabilities — it cannot access any other Ably resources.
