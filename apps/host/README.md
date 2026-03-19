# Airloom

Run AI on your computer, control it from your phone. End-to-end encrypted.

```
Phone (Viewer)  <--E2E encrypted-->  Relay  <--E2E encrypted-->  Computer (Host)
                                   (WS or Ably)
```

## Quick Start

```bash
npx airloom
```

A QR code and pairing code will appear in your terminal. Scan it with the Airloom viewer on your phone to connect.

Airloom ships with a built-in community relay via Ably — no server to run, no API keys to configure.

## Install

```bash
npm install -g airloom
airloom
```

Or run directly with npx:

```bash
npx airloom
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `RELAY_URL` | — | WebSocket relay URL. When set, disables Ably and uses self-hosted relay |
| `ABLY_API_KEY` | built-in community key | Your own Ably key. Overrides the shared community relay |
| `ABLY_TOKEN_TTL` | `86400000` (24h) | Viewer token lifetime in ms |
| `HOST_PORT` | `3000` | Local web UI port |
| `ANTHROPIC_API_KEY` | — | Anthropic API key for Claude |
| `OPENAI_API_KEY` | — | OpenAI API key for GPT |
| `AIRLOOM_CLI_COMMAND` | — | Shell command for CLI adapter |
| `AI_ADAPTER` | — | Adapter type: `anthropic`, `openai`, or `cli` |
| `AI_MODEL` | — | Model name override |

## Self-Hosted Relay

The community relay uses a shared Ably quota. For heavier use, set `ABLY_API_KEY` with your own key (free at https://ably.com), or use a self-hosted WebSocket relay:

```bash
RELAY_URL=ws://your-relay:4500 airloom
```

## Security

All messages between host and viewer are end-to-end encrypted with ChaCha20-Poly1305. The relay (whether self-hosted WebSocket or Ably) only sees opaque ciphertext. The encryption key is derived from the pairing code using HKDF-SHA256 — it never leaves the two endpoints.

## Requirements

- Node.js >= 18

## License

MIT
