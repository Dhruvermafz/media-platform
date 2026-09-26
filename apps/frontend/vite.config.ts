import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the app is served by Vite and the API runs separately, so proxy
// /api -> the API (real one on :3000, or `npm run mock` on :3000 too).
// Streaming must not be buffered or the live-update connection stalls.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: { sourcemap: true },
});
