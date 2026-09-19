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
 * MOCK_MIRROR            1 to read the real clinic (PROSPER_API_*) and still submit here
 * MOCK_SUITE_SEED        seed for the randomly generated asks (1)
 * MOCK_SUITE_RANDOM      how many random asks to generate in mirror mode (12)
 * TESTLAB_AGENT_WS       the agent's media socket (ws://127.0.0.1:7860/ws)
 * TESTLAB_AGENT_HTTP     the agent's console, for the transcript feed (http://127.0.0.1:7860)
 * TESTLAB_OUT            where call recordings go (./calls/testlab)
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { Router } from './http.js';
import { availabilityRoutes } from './routes/availability.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { controlRoutes } from './routes/control.js';
import { mirrorRoutes } from './routes/mirror.js';
import { patientRoutes } from './routes/patients.js';
import { submitRoutes } from './routes/submit.js';
import { testlabRoutes } from './routes/testlab.js';
import { Calls } from './submit/calls.js';
import { buildSuite } from './world/suite/index.js';
import { RealWorld } from './world/suite/real/context.js';
import { buildRealSuite, type Generation } from './world/suite/real/index.js';
import { loadSnapshot } from '../testlab/real/harvest.js';
import { scenarios } from './world/scenarios.js';
import { buildWorld } from './world/world.js';
import { Runner } from '../testlab/runner.js';

// Only the test lab's persona callers want keys, and they read them from here.
if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.MOCK_PROSPER_PORT ?? 8787);
const seed = Number(process.env.MOCK_SEED ?? 2026);
const crowd = Number(process.env.MOCK_PATIENTS ?? 800);
const acceptAny = process.env.MOCK_ACCEPT_ANY_CALL === '1';
// Reads from the real clinic, writes still local: a case can then name a real
// patient and a slot that exists, and grading it costs the practice nothing.
const mirror = process.env.MOCK_MIRROR === '1';
const generation: Generation = {
  source: mirror ? 'real' : 'generated',
  seed: Number(process.env.MOCK_SUITE_SEED ?? 1),
  random: mirror ? Number(process.env.MOCK_SUITE_RANDOM ?? 12) : 0,
};

const started = Date.now();
const world = buildWorld(seed, crowd);
const calls = new Calls(acceptAny);
const cases = scenarios(world);
const real = mirror ? new RealWorld(await loadSnapshot()) : null;
const lab = {
  suite: real ? await buildRealSuite(real, generation) : buildSuite(world),
  generation,
  /** Rebuilding is how a run is made repeatable: same seed, same asks. */
  regenerate: async (seed: number, random: number) => {
    if (!real) throw new Error('only the real-clinic suite can be regenerated (MOCK_MIRROR=1)');
    lab.generation = { source: 'real', seed, random };
    lab.suite = await buildRealSuite(real, lab.generation);
    runner.useSuite(lab.suite);
    return lab.suite;
  },
};
const runner = new Runner(lab.suite, {
  agentWs: process.env.TESTLAB_AGENT_WS ?? 'ws://127.0.0.1:7860/ws',
  agentHttp: process.env.TESTLAB_AGENT_HTTP ?? 'http://127.0.0.1:7860',
  mockUrl: `http://127.0.0.1:${port}`,
  outDir: process.env.TESTLAB_OUT ?? './calls/testlab',
});

const router = new Router();
// Before the invented world's routes, so it wins the reads it covers.
if (mirror) {
  const base = process.env.PROSPER_API_BASE_URL;
  const key = process.env.PROSPER_API_KEY;
  if (!base || !key) throw new Error('MOCK_MIRROR needs PROSPER_API_BASE_URL and PROSPER_API_KEY');
  mirrorRoutes(router, base, key);
}
catalogueRoutes(router, world);
patientRoutes(router, world);
availabilityRoutes(router, world);
submitRoutes(router, calls);
controlRoutes(router, world, calls, cases);
testlabRoutes(router, lab, runner);

createServer((req, res) => void router.handle(req, res)).listen(port, () => {
  console.log(
    `[mock] ${world.catalogue.raw.clinic_name} · ${world.patients.length} patients · ` +
      `${world.diary.appointments.length} appointments · seed ${seed} · built in ${Date.now() - started}ms`,
  );
  console.log(`[mock] Prosper API on http://127.0.0.1:${port}/api/v1 · control on /__mock`);
  console.log(`[mock] scenarios: ${cases.map((s) => s.name).join(', ')}`);
  console.log(
    `[mock] test lab on /__testlab · ${lab.suite.cases.length} cases over ${lab.suite.problems.length} problems` +
      ` · ${generation.source} suite, seed ${generation.seed}`,
  );
  if (acceptAny) console.log('[mock] accepting submissions for any call_id');
  if (mirror) console.log(`[mock] mirror: reads go to ${process.env.PROSPER_API_BASE_URL}, submissions stay here`);
});
