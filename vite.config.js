/**
 * Development/build configuration.
 * web-tree-sitter is excluded from dependency pre-bundling so its WASM loader
 * can resolve the runtime correctly.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Large, rarely changing libraries get their own long-cacheable chunks.
const vendorChunk = (name, packages) => ({
  name,
  test: new RegExp(`[\\\\/]node_modules[\\\\/](${packages.join('|')})[\\\\/]`),
});

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 3000 },
  // web-tree-sitter must not be pre-bundled or its wasm loader breaks
  optimizeDeps: { exclude: ['web-tree-sitter'] },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            vendorChunk('react', ['react', 'react-dom', 'scheduler']),
            vendorChunk('react-flow', ['@xyflow']),
            vendorChunk('tree-sitter', ['web-tree-sitter']),
          ],
        },
      },
    },
  },
});
