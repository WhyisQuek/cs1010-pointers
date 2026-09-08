/**
 * Development/build configuration.
 * web-tree-sitter is excluded from dependency pre-bundling so its WASM loader
 * can resolve the runtime correctly.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 3000 },
  // web-tree-sitter must not be pre-bundled or its wasm loader breaks
  optimizeDeps: { exclude: ['web-tree-sitter'] },
});
