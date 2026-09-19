/**
 * A local Prosper: the platform API with the same routes, bodies, errors and
 * submission window, over an invented clinic. Point the agent at it and nothing
 * leaves the machine — no practice-call rate limit, no Run All, no real records.
 *
 *   pnpm mock                 serves on :8787
 *   pnpm start:local          the agent, pointed here
 *   pnpm harness:local -- --scenario simple
 *
 * MOCK_PROSPER_PORT      port (8787)
 * MOCK_SEED              world seed (2026) — same seed, same patients, on every machine
 * MOCK_PATIENTS          crowd size (800)
 * MOCK_ACCEPT_ANY_CALL   1 to accept submissions for calls the harness never opened
 */
import { createServer } from 'node:http';
import { Router } from './http.js';
import { availabilityRoutes } from './routes/availability.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { controlRoutes } from './routes/control.js';
import { patientRoutes } from './routes/patients.js';
import { submitRoutes } from './routes/submit.js';
import { Calls } from './submit/calls.js';
import { scenarios } from './world/scenarios.js';
import { buildWorld } from './world/world.js';

const port = Number(process.env.MOCK_PROSPER_PORT ?? 8787);
const seed = Number(process.env.MOCK_SEED ?? 2026);
const crowd = Number(process.env.MOCK_PATIENTS ?? 800);
const acceptAny = process.env.MOCK_ACCEPT_ANY_CALL === '1';

const started = Date.now();
const world = buildWorld(seed, crowd);
const calls = new Calls(acceptAny);
const cases = scenarios(world);

const router = new Router();
catalogueRoutes(router, world);
patientRoutes(router, world);
availabilityRoutes(router, world);
submitRoutes(router, calls);
controlRoutes(router, world, calls, cases);

createServer((req, res) => void router.handle(req, res)).listen(port, () => {
  console.log(
    `[mock] ${world.catalogue.raw.clinic_name} · ${world.patients.length} patients · ` +
      `${world.diary.appointments.length} appointments · seed ${seed} · built in ${Date.now() - started}ms`,
  );
  console.log(`[mock] Prosper API on http://127.0.0.1:${port}/api/v1 · control on /__mock`);
  console.log(`[mock] scenarios: ${cases.map((s) => s.name).join(', ')}`);
  if (acceptAny) console.log('[mock] accepting submissions for any call_id');
});
