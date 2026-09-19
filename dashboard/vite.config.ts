import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The agent process from the repo root: its HTTP/SSE console lives on :7860. */
const AGENT_ORIGIN = process.env.VITE_AGENT_ORIGIN ?? 'http://localhost:7860';
/** The shared clinic (`pnpm sim`), when the agent is pointed at it: its /__sim routes on :8788. */
const SIM_ORIGIN = process.env.VITE_SIM_ORIGIN ?? 'http://localhost:8788';

/**
 * `pnpm dev:https`: the same console over a self-signed certificate, for a phone on the
 * same network. Browsers only give a page the microphone on https (or localhost), and the
 * Test call tab needs it. The phone warns about the certificate once; accept and go on.
 */
const HTTPS = process.env.DASHBOARD_HTTPS === '1';

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(HTTPS ? [basicSsl()] : [])],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // '::' is dual-stack: localhost resolves to either ::1 or 127.0.0.1 depending on
    // the machine, and binding IPv6-only leaves half of those refusing connections.
    // It also puts the console on the LAN, which is what a demo to the room needs.
    host: '::',
    port: HTTPS ? 5174 : 5173,
    // Same-origin in dev, so EventSource needs no CORS dance and cookies would carry.
    proxy: {
      '/health': AGENT_ORIGIN,
      '/mode': AGENT_ORIGIN,
      '/calls': AGENT_ORIGIN,
      '/stats': AGENT_ORIGIN,
      '/events': { target: AGENT_ORIGIN, changeOrigin: true, ws: false },
      '/__sim': { target: SIM_ORIGIN, changeOrigin: true, ws: false },
      // The agent's call socket, for the Test tab's "Local agent" endpoint.
      '/ws': { target: AGENT_ORIGIN, ws: true },
    },
  },
});
