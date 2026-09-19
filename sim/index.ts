/**
 * A persistent Prosper: one clinic, shared by every call, kept on disk.
 *
 * On first boot it copies the live clinic (catalogue and calendar occupancy) into
 * sim/data/clinic.db; after that the copy is the clinic. Calls that book, move, cancel
 * or register change it for every call that follows, and a call that has quoted a
 * slot can hold it so no other call books it meanwhile.
 *
 *   pnpm sim                  serves on :8788
 *   pnpm start:sim            the agent, pointed here (holds on)
 *   pnpm harness -- --prosper http://127.0.0.1:8788 --n 5
 *
 * SIM_PORT                port (8788)
 * SIM_DB                  the database (sim/data/clinic.db)
 * SIM_HOLD_TTL_MS         how long a hold lasts without being renewed (120000)
 * SIM_STRICT_CALLS        1 to 404 submissions for calls nobody announced, as the real API does
 * SIM_RESNAPSHOT          1 to throw the copy away and take it again at boot
 * PROSPER_API_BASE_URL    where the copy comes from (and where patients are looked up)
 * PROSPER_API_KEY
 */
import { existsSync } from 'node:fs';
import { Clinic } from './clinic.js';
import { openDb } from './db.js';
import { ProsperClient } from './prosper.js';
import { createSimServer } from './server.js';
import { snapshotFromLive } from './snapshot.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.SIM_PORT ?? 8788);
const dbPath = process.env.SIM_DB ?? new URL('./data/clinic.db', import.meta.url).pathname;
const holdTtlMs = Number(process.env.SIM_HOLD_TTL_MS ?? 120_000);
const strict = process.env.SIM_STRICT_CALLS === '1';
const resnapshot = process.env.SIM_RESNAPSHOT === '1';

const log = (line: string): void => console.log(`[sim] ${line}`);

const live = new ProsperClient({
  baseUrl: process.env.PROSPER_API_BASE_URL ?? 'https://hackspain.getprosperapp.com',
  apiKey: process.env.PROSPER_API_KEY ?? '',
});
if (live.baseUrl.includes(`:${port}`)) {
  console.error(`[sim] PROSPER_API_BASE_URL points at the sim itself (${live.baseUrl}); set it to the live API for the copy`);
  process.exit(1);
}

const db = openDb(dbPath);
if (resnapshot || !Clinic.hasSnapshot(db)) {
  if (!live.configured) {
    console.error('[sim] no snapshot yet and no PROSPER_API_KEY to take one with');
    process.exit(1);
  }
  const started = Date.now();
  await snapshotFromLive(db, live, log);
  log(`snapshot taken in ${Date.now() - started}ms → ${dbPath}`);
} else {
  log(`reusing ${dbPath}`);
}

const clinic = new Clinic({ db, live, holdTtlMs, acceptAnyCall: !strict, log });
const sweep = setInterval(() => clinic.expireHolds(), 1_000);
sweep.unref();

clinic.on('event', (e) => {
  if (e.type === 'hold' || e.type === 'hold_released' || e.type === 'hold_expired' || e.type === 'hold_conflict') {
    log(`${e.type} ${String(e.data.start_time ?? '')} ${String(e.data.provider_id ?? '')} · call ${e.call_id?.slice(0, 8) ?? '-'}`);
  }
});

const server = createSimServer({ clinic, live: live.configured ? live : null, log });
server.listen(port, () => {
  const s = clinic.state();
  log(`${clinic.clinicBody.clinic_name} · snapshot of ${String((s.snapshot as { source: string }).source)} at ${String((s.snapshot as { taken_at: string }).taken_at)}`);
  log(`${String(s.busy_cells)} busy cells · ${JSON.stringify(s.patients)} patients · ${JSON.stringify(s.appointments)} appointments`);
  log(`Prosper API on http://127.0.0.1:${port}/api/v1 · sim on /__sim · events on /__sim/events`);
  log(`holds last ${holdTtlMs}ms · ${strict ? 'strict' : 'any'} call ids · patients looked up ${live.configured ? 'live' : 'locally only'}`);
});

const stop = (): void => {
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
