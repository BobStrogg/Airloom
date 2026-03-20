import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds a single self-contained index.html for GitHub Pages (docs/).
// All JS, CSS, and dynamic imports are inlined into one file.
export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: '../../docs',
    emptyOutDir: true,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  plugins: [
    nodePolyfills({
      include: ['events'],
      globals: { Buffer: false, global: false, process: false },
    }),
    viteSingleFile(),
  ],
});
