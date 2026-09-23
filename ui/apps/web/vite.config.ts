import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'COGNITO_'],
  base: process.env.VITE_DEMO === 'true' ? '/Boxalarm-monorepo/' : '/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        silentRenew: resolve(import.meta.dirname, 'silent-renew.html'),
      },
    },
  },
  test: { environment: 'jsdom', exclude: ['tests/e2e/**', 'node_modules/**'] },
});
