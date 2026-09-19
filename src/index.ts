import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { initializeLogger } from '@livekit/agents';
import { WebSocketServer } from 'ws';
import { CallSession, type Shared } from './call-session.js';
import { loadClinic } from './clinic.js';
import { DEFAULT_TOOL_TIMEOUT_MS } from './agent-tools.js';
import { ClinicApi } from './clinic-api.js';
import { setPlanVocabulary } from './call-state.js';
import { setProviderVocabulary } from './extract.js';
import { config } from './config.js';
import { loadVad } from './models.js';
import { openStore } from './store/index.js';
import { tagLiveKitLogger } from './log.js';
import { simFetch } from './sim-holds.js';
import { CLINIC_URLS, clinicTarget, isClinicMode, setClinicMode } from './clinic-target.js';
import { wavHeader } from './recorder.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** One process, one WebSocket server, one headless AgentSession per socket. */
async function main(): Promise<void> {
  // The CLI worker normally does this; without it every plugin throws on first use.
  initializeLogger({ pretty: true, level: process.env.LOG_LEVEL ?? 'info' });
  tagLiveKitLogger(process.env.LOG_LEVEL ?? 'info');

  console.log('[boot] loading Silero VAD and the clinic catalogue');

  // Shared on purpose: one copy of the VAD weights, one catalogue.
  const [vad, clinic] = await Promise.all([loadVad(), loadClinic()]);
  const store = openStore();

  // Abort under the per-tool cap, so a slow API surfaces as a failure the agent can
  // explain rather than as the tool giving up on a request still in flight.
  // One client per clinic; a call picks the one for the mode it opened in.
  const api = {
    live: new ClinicApi({ baseUrl: CLINIC_URLS.live, apiKey: config.prosper.apiKey, timeoutMs: DEFAULT_TOOL_TIMEOUT_MS - 500 }),
    simulation: new ClinicApi({
      baseUrl: CLINIC_URLS.simulation,
      apiKey: config.prosper.apiKey,
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS - 500,
      fetch: simFetch(),
    }),
  };
  console.log(`[boot] clinic mode ${clinicTarget().mode} · live ${CLINIC_URLS.live} · simulation ${CLINIC_URLS.simulation}`);

  // Doctors, sites, plans and closures are identical all event: parsed once here off the
  // document `loadClinic` already fetched, so no call ever pays for them. The sim is a
  // copy of the same clinic, so it shares the catalogue.
  const catalogue = clinic.raw === null ? null : api.live.primeCatalogue(clinic.raw);
  if (clinic.raw !== null) api.simulation.primeCatalogue(clinic.raw);
  // So a plan written down mid-call is the clinic's id, not the caller's pronunciation.
  if (catalogue) {
    setPlanVocabulary(catalogue.plans);
    setProviderVocabulary(catalogue);
  }

  const shared: Shared = {
    vad,
    keyterms: clinic.keyterms,
    clinicBriefing: clinic.briefing,
    store,
    api,
    catalogue,
    recorders: new Map(),
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

  // Consoles on /events hear a mode switch as an event, so every open tab follows.
  const modeListeners = new EventEmitter();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (body: unknown, code = 200): void => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end(JSON.stringify(body, null, 2));
    };
    if (req.method === 'OPTIONS') return json(null, 204);

    // Which clinic new calls book into, so the console can say "simulation" vs the real board.
    const health = (): unknown => {
      const target = clinicTarget();
      return { ok: true, live: wss.clients.size, clinic_api: target.baseUrl, mode: target.mode, clinics: CLINIC_URLS };
    };
    if (url.pathname === '/health') return json(health());

    // The console's mode switch. Calls already open keep the clinic they started on.
    if (url.pathname === '/mode' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        let mode: unknown;
        try {
          mode = (JSON.parse(raw) as { mode?: unknown }).mode;
        } catch {
          return json({ detail: 'body must be JSON' }, 400);
        }
        if (!isClinicMode(mode)) return json({ detail: 'mode must be "live" or "simulation"' }, 422);
        const target = setClinicMode(mode);
        console.log(`[mode] ${target.mode} · new calls book into ${target.baseUrl}`);
        modeListeners.emit('mode', health());
        return json(health());
      });
      return;
    }

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
      const onMode = (body: unknown): void => {
        res.write(`event: mode\ndata: ${JSON.stringify(body)}\n\n`);
      };
      modeListeners.on('mode', onMode);
      // Proxies and tunnels drop an idle stream; this also surfaces the live call count.
      const beat = setInterval(() => {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ live: wss.clients.size, at: Date.now() })}\n\n`);
      }, 15_000);
      const stop = (): void => {
        clearInterval(beat);
        store.off('row', onRow);
        modeListeners.off('mode', onMode);
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
    if (url.pathname.endsWith('/listen') && url.pathname.startsWith('/calls/')) {
      const callId = decodeURIComponent(url.pathname.slice('/calls/'.length, -'/listen'.length));
      const recorder = shared.recorders.get(callId);
      if (!recorder) return json({ error: 'recording not live' }, 404);

      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(wavHeader({ channels: 2, sampleRate: 8000, dataBytes: 0xffffffff - 36 }));
      let writable = true;
      const onChunk = (chunk: Buffer): void => {
        if (writable && !res.write(chunk)) writable = false;
      };
      const onDrain = (): void => {
        writable = true;
      };
      const stop = (): void => {
        recorder.off('chunk', onChunk);
        recorder.off('close', stop);
        res.off('drain', onDrain);
        if (!res.writableEnded) res.end();
      };
      recorder.on('chunk', onChunk);
      recorder.once('close', stop);
      res.on('drain', onDrain);
      req.on('close', stop);
      return;
    }
    if (url.pathname.endsWith('/recording.wav') && url.pathname.startsWith('/calls/')) {
      const callId = decodeURIComponent(url.pathname.slice('/calls/'.length, -'/recording.wav'.length));
      void store.query('call', { call_id: callId }).then(async (rows) => {
        const recordingPath = (rows as { call?: { recording_path?: string | null } } | null)?.call?.recording_path;
        if (!recordingPath) return json({ error: 'recording not found' }, 404);
        const root = resolve(join(config.logDir, 'recordings'));
        const path = resolve(recordingPath);
        if (path !== root && !path.startsWith(root + '/')) return json({ error: 'recording not found' }, 404);
        try {
          const info = await stat(path);
          const range = urlPathRange(req.headers.range, info.size);
          if (range?.invalid) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            return res.end();
          }
          const start = range?.start ?? 0;
          const end = range?.end ?? info.size - 1;
          const headers: Record<string, string | number> = {
            'Content-Type': 'audio/wav',
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Access-Control-Allow-Origin': '*',
          };
          if (range) {
            headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
            res.writeHead(206, headers);
          } else {
            res.writeHead(200, headers);
          }
          createReadStream(path, { start, end }).pipe(res);
        } catch {
          json({ error: 'recording not found' }, 404);
        }
      });
      return;
    }
    // The overview's numbers, over a range: `since` an ISO instant, `bucket_ms` the series grain.
    if (url.pathname === '/stats') {
      // Rows hold UTC ISO strings and are compared as text, so `since` is normalised to the
      // same form whatever offset it arrived with.
      const raw = url.searchParams.get('since');
      const since = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : undefined;
      const bucket = Number(url.searchParams.get('bucket_ms') ?? 3_600_000);
      void store
        .query('stats', { since, bucket_ms: Number.isFinite(bucket) ? bucket : 3_600_000 })
        .then((stats) => json({ live: wss.clients.size, ...(stats as object) }, stats ? 200 : 503));
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

function urlPathRange(
  value: string | undefined,
  size: number,
): { start: number; end: number; invalid?: false } | { invalid: true } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    return { invalid: true };
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

// A crash in one call must not take the other nine down.
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaught exception]', err));

main().catch((err: unknown) => {
  console.error('[boot] failed', err);
  process.exit(1);
});
