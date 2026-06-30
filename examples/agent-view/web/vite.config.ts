import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app talks to the Python backend (examples/agent-view/backend) at /api/*.
// In dev we proxy /api -> the backend so the SSE stream works without CORS.
const BACKEND = process.env.AGENT_VIEW_BACKEND ?? 'http://127.0.0.1:8800';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
      },
    },
  },
});
