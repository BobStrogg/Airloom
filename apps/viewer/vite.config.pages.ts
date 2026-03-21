import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { viteSingleFile } from 'vite-plugin-singlefile';

const require = createRequire(import.meta.url);

// Builds a single self-contained index.html for GitHub Pages (docs/).
// All JS, CSS, and dynamic imports are inlined into one file.
export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: '../../docs',
    emptyOutDir: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  resolve: {
    alias: {
      // Browser-compatible EventEmitter polyfill (replaces vite-plugin-node-polyfills
      // which is broken on Node 25 due to node-stdlib-browser incompatibility).
      events: require.resolve('events/events.js'),
    },
  },
  plugins: [viteSingleFile()],
});
