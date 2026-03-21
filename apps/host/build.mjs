import esbuild from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/index.ts'],
  format: 'esm',
  target: 'node18',
  platform: 'node',
  bundle: true,
  outfile: 'dist/index.js',
  banner: { js: '#!/usr/bin/env node' },
  external: [
    '@noble/hashes', '@xterm/addon-fit', '@xterm/xterm',
    'ably', 'events', 'express', 'node-pty', 'qrcode', 'tweetnacl', 'ws',
    'node:*', 'fs', 'path', 'os', 'crypto', 'http', 'net', 'stream',
    'child_process', 'util', 'tty', 'process',
  ],
});

console.log('Build complete → dist/index.js');
