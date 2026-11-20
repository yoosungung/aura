import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const devProxyTarget =
  process.env.VITE_DEV_PROXY_TARGET || 'http://localhost:18080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/v1': {
        target: devProxyTarget,
        changeOrigin: true,
      },
      '/api/healthz': {
        target: devProxyTarget,
        changeOrigin: true,
        rewrite: () => '/healthz',
      },
    },
  },
  build: {
    // Flat dist/ so kubectl ConfigMap --from-file=dist works (no nested assets/).
    rollupOptions: {
      output: {
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
