# Airloom — Agent Instructions

## Package Manager: pnpm ONLY

This project uses **pnpm exclusively**. Do NOT use `npm` or `yarn` for any operation.

- **Install dependencies:** `pnpm install`
- **Add a dependency:** `pnpm add <package>` or `pnpm add -D <package>`
- **Run a script:** `pnpm <script>` or `pnpm run <script>`
- **Run in a workspace package:** `pnpm --filter <package-name> <command>`
- **Never run:** `npm install`, `npm add`, `npm run`, `yarn install`, `yarn add`, etc.

The project enforces this via:
- `"packageManager": "pnpm@..."` in package.json (corepack)
- `"preinstall": "npx only-allow pnpm"` script (blocks npm/yarn install)

## Build & Verification

```bash
pnpm typecheck
pnpm --filter @airloom/host build
pnpm build:pages
```

## Project Structure

- `apps/host` — host process and local UI
- `apps/viewer` — phone UI (xterm.js terminal)
- `packages/channel` — encrypted channel abstraction
- `packages/protocol` — message and payload types
- `packages/relay` — self-hosted WS relay

See `WINDSURF_CONTEXT.md` for full architecture and protocol details.
