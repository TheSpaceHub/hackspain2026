import { createServer } from 'node:http';
import { initializeLogger } from '@livekit/agents';
import { WebSocketServer } from 'ws';
import { CallSession, type Shared } from './call-session.js';
import { loadClinic } from './clinic.js';
import { ClinicApi } from './clinic-api.js';
import { config } from './config.js';
import { loadVad } from './models.js';
import { openStore } from './store/index.js';

/** One process, one WebSocket server, one headless AgentSession per socket. */
async function main(): Promise<void> {
  // The CLI worker normally does this; without it every plugin throws on first use.
  initializeLogger({ pretty: true, level: process.env.LOG_LEVEL ?? 'info' });

  console.log('[boot] loading Silero VAD and the clinic catalogue');

  // Shared on purpose: one copy of the VAD weights, one catalogue.
  const [vad, clinic] = await Promise.all([loadVad(), loadClinic()]);
  const store = openStore();

  // Doctors, sites, plans and closures are identical all event: parsed once here off the
  // document `loadClinic` already fetched, so no call ever pays for them.
  const api = new ClinicApi({ baseUrl: config.prosper.baseUrl, apiKey: config.prosper.apiKey });
  const catalogue = clinic.raw === null ? null : api.primeCatalogue(clinic.raw);

  const shared: Shared = {
    vad,
    keyterms: clinic.keyterms,
    clinicBriefing: clinic.briefing,
    store,
    api,
    catalogue,
  };

  console.log(`[boot] clinic catalogue from ${clinic.source}, ${clinic.keyterms.length} keyterms`);
  console.log(
    catalogue
      ? `[boot] cached ${catalogue.providers.length} providers, ${catalogue.locations.length} sites, ${catalogue.plans.length} plans`
      : '[boot] no catalogue: lookups still work, catalogue answers do not',
  );
  console.log(
    config.provider === 'anthropic'
      ? `[boot] llm ${config.anthropic.model} (call effort ${config.anthropic.callEffort}) · decider ${config.anthropic.deciderModel} (effort ${config.anthropic.deciderEffort})`
      : `[boot] llm ${config.cloudflare.model} · decider ${config.cloudflare.deciderModel}`,
  );

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (body: unknown, code = 200): void => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(body, null, 2));
    };

    if (url.pathname === '/health') return json({ ok: true, live: wss.clients.size });

    // Realtime feed for a dashboard: one SSE event per row the store writes, as it is
    // written. EventSource in the browser, no dependency, and CORS-open so the dashboard
    // can be served from anywhere.
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ live: wss.clients.size })}\n\n`);

      const onRow = (row: unknown): void => {
        res.write(`event: ${(row as { type: string }).type}\ndata: ${JSON.stringify(row)}\n\n`);
      };
      store.on('row', onRow);
      // Proxies and tunnels drop an idle stream; this also surfaces the live call count.
      const beat = setInterval(() => {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ live: wss.clients.size, at: Date.now() })}\n\n`);
      }, 15_000);
      const stop = (): void => {
        clearInterval(beat);
        store.off('row', onRow);
      };
      req.on('close', stop);
      res.on('error', stop);
      return;
    }

    // Read-only console: what happened on a call, and why it decided what it did.
    if (url.pathname === '/calls') {
      void store
        .query('recent', { limit: Number(url.searchParams.get('limit') ?? 50) })
        .then((rows) => json({ live: wss.clients.size, calls: rows }));
      return;
    }
    if (url.pathname.startsWith('/calls/')) {
      const callId = decodeURIComponent(url.pathname.slice('/calls/'.length));
      void store.query('call', { call_id: callId }).then((rows) => json(rows ?? {}, rows ? 200 : 404));
      return;
    }
    res.writeHead(426).end('upgrade required');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Ten sockets means ten of these, sharing only `shared`.
    new CallSession(ws, shared);
    console.log(`[ws] connection from ${req.socket.remoteAddress} · ${wss.clients.size} open`);
  });

  server.listen(config.port, () => {
    console.log(`[boot] listening on :${config.port}, path /ws`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[boot] ${signal}, closing`);
    // Let in-flight calls finish their submission window.
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 35_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// A crash in one call must not take the other nine down.
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaught exception]', err));

main().catch((err: unknown) => {
  console.error('[boot] failed', err);
  process.exit(1);
});
