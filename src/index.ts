import { createServer } from 'node:http';
import { initializeLogger } from '@livekit/agents';
import { WebSocketServer } from 'ws';
import { CallSession, type Shared } from './call-session.js';
import { loadClinic } from './clinic.js';
import { config } from './config.js';
import { loadVad } from './models.js';

/**
 * One process, one WebSocket server, one headless AgentSession per socket.
 * No LiveKit server, no SIP, no rooms.
 */
async function main(): Promise<void> {
  // The agents framework logs through a module-level pino instance that its own
  // CLI worker normally sets up. We do not run that worker, so we do it here —
  // without this every plugin throws "logger not initialized" on first use.
  initializeLogger({ pretty: true, level: process.env.LOG_LEVEL ?? 'info' });

  console.log('[boot] loading Silero VAD and the clinic catalogue');

  // The two things shared on purpose: one copy of the VAD weights, and a
  // catalogue that is generated once and identical for the whole event.
  const [vad, clinic] = await Promise.all([loadVad(), loadClinic()]);
  const shared: Shared = { vad, keyterms: clinic.keyterms };

  console.log(`[boot] clinic catalogue from ${clinic.source}, ${clinic.keyterms.length} keyterms`);

  const server = createServer((req, res) => {
    // A plain GET is a health check, ours or a tunnel's.
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, calls: wss.clients.size }));
      return;
    }
    res.writeHead(426).end('upgrade required');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Everything this call owns is rooted in the CallSession and nothing else
    // can reach it. Ten sockets means ten of these, sharing only `shared`.
    new CallSession(ws, shared);
    console.log(`[ws] connection from ${req.socket.remoteAddress} · ${wss.clients.size} open`);
  });

  server.listen(config.port, () => {
    console.log(`[boot] listening on :${config.port}, path /ws`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[boot] ${signal}, closing`);
    // Let in-flight calls finish their submission window rather than cutting them.
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 35_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// A crash in one call must never take the process down with the other nine.
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaught exception]', err));

main().catch((err: unknown) => {
  console.error('[boot] failed', err);
  process.exit(1);
});
