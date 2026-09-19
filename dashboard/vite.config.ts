import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The agent process from the repo root: its HTTP/SSE console lives on :7860. */
const AGENT_ORIGIN = process.env.VITE_AGENT_ORIGIN ?? 'http://localhost:7860';
/** The local Prosper (pnpm mock) — it owns the generated world, so the test lab lives there. */
const TESTLAB_ORIGIN = process.env.VITE_TESTLAB_ORIGIN ?? 'http://localhost:8787';
const SIM_AGENT_ORIGIN = process.env.VITE_SIM_AGENT_ORIGIN ?? 'http://localhost:7861';
/** The shared clinic (`pnpm sim`), when the agent is pointed at it: its /__sim routes on :8788. */
const SIM_ORIGIN = process.env.VITE_SIM_ORIGIN ?? 'http://localhost:8788';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // '::' is dual-stack: localhost resolves to either ::1 or 127.0.0.1 depending on
    // the machine, and binding IPv6-only leaves half of those refusing connections.
    // It also puts the console on the LAN, which is what a demo to the room needs.
    host: '::',
    port: 5173,
    // Same-origin in dev, so EventSource needs no CORS dance and cookies would carry.
    proxy: {
      '/health': AGENT_ORIGIN,
      '/mode': AGENT_ORIGIN,
      '/calls': AGENT_ORIGIN,
      '/stats': AGENT_ORIGIN,
      '/events': { target: AGENT_ORIGIN, changeOrigin: true, ws: false },
      '/__testlab': { target: TESTLAB_ORIGIN, changeOrigin: true },
      '/agents/live': {
        target: AGENT_ORIGIN,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/agents\/live/, ''),
      },
      '/agents/simulation': {
        target: SIM_AGENT_ORIGIN,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/agents\/simulation/, ''),
      },
      '/__sim': { target: SIM_ORIGIN, changeOrigin: true, ws: false },
    },
  },
});
