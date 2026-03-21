import { defineConfig } from 'vite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  root: '.',
  base: './',
  build: { outDir: 'dist' },
  resolve: {
    alias: {
      // Browser-compatible EventEmitter polyfill (replaces vite-plugin-node-polyfills
      // which is broken on Node 25 due to node-stdlib-browser incompatibility).
      events: require.resolve('events/events.js'),
    },
  },
});
