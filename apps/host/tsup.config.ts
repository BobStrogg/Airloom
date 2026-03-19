import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  clean: true,
  // Bundle workspace packages so the published package is self-contained.
  // All other deps (express, ably, etc.) stay external and are installed by npm.
  noExternal: ['@airloom/protocol', '@airloom/crypto', '@airloom/channel'],
  // Shebang for `npx airloom`
  banner: { js: '#!/usr/bin/env node' },
});
