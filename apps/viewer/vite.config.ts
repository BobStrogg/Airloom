import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  root: '.',
  base: './',
  build: { outDir: 'dist' },
  plugins: [nodePolyfills({
    include: ['events'],
    globals: { Buffer: false, global: false, process: false },
  })],
});
