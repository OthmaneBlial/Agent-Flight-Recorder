import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const apiPort = process.env.AFR_DEV_API_PORT ?? '4174';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts'],
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: process.env.AFR_SOURCE_MAPS === '1',
  },
});
