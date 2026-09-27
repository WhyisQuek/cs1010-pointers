/**
 * Development/build configuration.
 * web-tree-sitter is excluded from dependency pre-bundling so its WASM loader
 * can resolve the runtime correctly.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Large, rarely changing libraries get their own long-cacheable chunks.
const VENDOR_CHUNKS = {
  react: ['react', 'react-dom', 'scheduler'],
  'react-flow': ['@xyflow'],
  'tree-sitter': ['web-tree-sitter'],
};

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 3000 },
  // web-tree-sitter must not be pre-bundled or its wasm loader breaks
  optimizeDeps: { exclude: ['web-tree-sitter'] },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const pkg = id.split('node_modules/')[1];
          if (!pkg) return undefined;
          return Object.entries(VENDOR_CHUNKS).find(([, prefixes]) =>
            prefixes.some(prefix => pkg === prefix || pkg.startsWith(`${prefix}/`)),
          )?.[0];
        },
      },
    },
  },
});
