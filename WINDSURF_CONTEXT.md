# Airloom Windsurf Context (Terminal Mode First)

This document is for AI coding sessions (Windsurf/Cursor/etc.) so they can work on this repo without regressing the terminal-mode goals.

---

## 1) Product goal (current)

Airloom is now **terminal-first** for phone control.

- Host runs on your computer.
- Viewer runs on phone browser/PWA.
- Relay transport is WS or Ably.
- Payloads between host/viewer are E2E encrypted.
- Viewer should behave like a **real terminal emulator** (xterm.js), not a chat bubble app.

### What “done” means for terminal mode

- User input is entered in terminal UI itself (shell prompt / CLI app prompt).
- Output is rendered with rich terminal features (ANSI, cursor movement, alternate screen, etc).
- No separate “chat send box” in terminal workflow.

---

## 2) Architecture map

- `apps/host` — host process and host local UI
- `apps/viewer` — phone UI (terminal)
- `packages/channel` — encrypted channel abstraction
- `packages/protocol` — message and payload types
- `packages/relay` — self-hosted WS relay

### Runtime flow (terminal)

1. Viewer connects and sends `terminal_open` with cols/rows.
2. Host spawns PTY (`node-pty`) running launch target (default shell unless overridden).
3. Host streams PTY output via encrypted channel stream with terminal meta.
4. Viewer writes chunks into xterm.js.
5. Viewer sends keystrokes via `terminal_input` and resize via `terminal_resize`.

---

## 3) Terminal protocol (important)

Defined in `packages/protocol/src/types.ts`:

- `terminal_open { cols, rows }`
- `terminal_input { data }`
- `terminal_resize { cols, rows }`
- `terminal_close {}`
- `terminal_exit { exitCode?, signal? }`

Also:
- terminal stream metadata uses `kind: 'terminal'`.

Do **not** replace this with chat-style `message` for terminal I/O.

---

## 4) Key host files

### `apps/host/src/terminal.ts`
- PTY session management.
- Default launch target logic.
- Adaptive batching for PTY output:
  - fast cadence after recent input (low latency)
  - slower cadence during long output bursts (lower overhead)

### `apps/host/src/index.ts`
- startup args (`--cli`, `--preset`, etc)
- computes effective terminal launch target
- creates `TerminalSession`
- routes terminal channel messages to session

### `apps/host/src/server.ts`
- local host web UI HTML/JS
- launch configuration controls
- status API includes terminal launch info

### `apps/host/src/config.ts`
- persisted config supports `type: 'terminal'` (plus legacy modes)

---

## 5) Key viewer files

### `apps/viewer/src/main.ts`
- xterm.js setup
- terminal input/output events
- resize sync
- terminal utility buttons (keyboard, ctrl-c, esc, tab)

### `apps/viewer/index.html` + `apps/viewer/src/style.css`
- terminal screen/layout
- no chat bubble workflow for terminal use

---

## 6) Build/deploy behavior (critical)

There are two distinct viewer artifacts that must be current:

1. **Bundled viewer in host package**
   - Path: `apps/host/dist/viewer/*`
   - Used by local/published host package runtime

2. **GitHub Pages viewer**
   - Path: `docs/index.html` (single-file build)
   - Used by default QR target URL

### Required commands

From repo root:

```bash
pnpm typecheck
pnpm --filter @airloom/host build
pnpm build:pages
```

Notes:
- Host build script is set to rebuild viewer first, then copy it into host dist.
- Pages build may clear docs output; ensure `docs/.nojekyll` exists for Pages.

---

## 7) Launch behavior rules

Expected behavior:

- Default launch target: **current shell** (`$SHELL -il` on unix-like, COMSPEC/powershell fallback on Windows).
- If command-line override is provided (`--cli`, `--preset`), it becomes launch target.
- Host UI should display effective launch target, e.g.:
  - `Launch: /bin/zsh -il`
  - `Launch: devin`

Host UI should include explicit option:
- `Shell (default)`

---

## 8) Known pitfalls to avoid

1. **Reintroducing chat-mode assumptions into terminal mode**
   - Don’t route terminal input through a separate chat textbox.

2. **Forgetting to rebuild `docs/`**
   - Phone QR defaults to Pages; stale docs means users still see old UI.

3. **Using old published package when testing new behavior**
   - `npx airloom@<old-version>` won’t include local fixes.

4. **`node-pty` helper permission issue**
   - Repo includes postinstall permission fix script for `spawn-helper` executable bit.

5. **Treating terminal launch target as AI adapter selection**
   - terminal mode launch target is its own concern; keep it explicit.

---

## 9) Validation checklist after changes

- [ ] `pnpm typecheck` passes
- [ ] `pnpm --filter @airloom/host build` passes
- [ ] `pnpm build:pages` passes
- [ ] `apps/host/dist/viewer/index.html` contains terminal markers (`terminalScreen`, `Keyboard`)
- [ ] `docs/index.html` reflects terminal UI (not old chat bundle)
- [ ] Host UI shows launch target text
- [ ] `Shell (default)` appears in launch dropdown
- [ ] Entering `ls` in viewer terminal works as shell command (not executed as binary launch target)

---

## 10) If you need to explain this to another AI quickly

Use this summary:

> Airloom is terminal-first now. Viewer is xterm.js, host runs node-pty. Terminal I/O uses explicit terminal protocol messages over encrypted channel, not chat messages. Keep default launch as current shell, support CLI/preset overrides, show effective launch target in host UI. Always rebuild both host bundled viewer and docs/pages viewer after UI changes.

