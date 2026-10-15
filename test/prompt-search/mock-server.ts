/**
 * The local Prosper (`mock/`) started in-process on a free port, so a search run
 * neither needs `pnpm mock` beside it nor shares a call ledger with anything else.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from '../../mock/http.js';
import { availabilityRoutes } from '../../mock/routes/availability.js';
import { catalogueRoutes } from '../../mock/routes/catalogue.js';
import { controlRoutes } from '../../mock/routes/control.js';
import { patientRoutes } from '../../mock/routes/patients.js';
import { submitRoutes } from '../../mock/routes/submit.js';
import { Calls } from '../../mock/submit/calls.js';
import { scenarios, type Scenario } from '../../mock/world/scenarios.js';
import { buildWorld, type World } from '../../mock/world/world.js';

export interface MockProsper {
  baseUrl: string;
  world: World;
  calls: Calls;
  scenarios: Scenario[];
  close(): Promise<void>;
}

export async function startMock(seed = 2026, crowd = 800): Promise<MockProsper> {
  const world = buildWorld(seed, crowd);
  const calls = new Calls(true);
  const cases = scenarios(world);
  const router = new Router();
  catalogueRoutes(router, world);
  patientRoutes(router, world);
  availabilityRoutes(router, world);
  submitRoutes(router, calls);
  controlRoutes(router, world, calls, cases);

  const server: Server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    world,
    calls,
    scenarios: cases,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
