/**
 * Mock-only routes, under /__mock so they can never be mistaken for the contract.
 * They stand in for the part of Prosper no API exposes: the harness dialling a
 * call, and the verdict on what came back.
 *
 *   GET  /__mock                     the world: seed, counts, anchor patients
 *   GET  /__mock/scenarios           the local cases, script and expectation each
 *   GET  /__mock/scenarios/:name
 *   POST /__mock/calls               {call_id, scenario?, from_number?} — a call opens
 *   POST /__mock/calls/:call_id/close                                    — its socket closed
 *   GET  /__mock/calls               every call, its record and its verdict
 *   GET  /__mock/calls/:call_id
 */
import { fail, ok, type Router } from '../http.js';
import type { CallState, Calls } from '../submit/calls.js';
import { WINDOW_MS } from '../submit/calls.js';
import { ANCHORS } from '../world/people.js';
import { grade, type Scenario } from '../world/scenarios.js';
import type { World } from '../world/world.js';

export function controlRoutes(router: Router, world: World, calls: Calls, cases: Scenario[]): void {
  const byName = new Map(cases.map((s) => [s.name, s]));

  const view = (c: CallState): Record<string, unknown> => {
    const scenario = c.scenario ? byName.get(c.scenario) : undefined;
    const windowOpen = c.closed_at === null || Date.now() - c.closed_at <= WINDOW_MS;
    return {
      ...c,
      opened_at: new Date(c.opened_at).toISOString(),
      closed_at: c.closed_at ? new Date(c.closed_at).toISOString() : null,
      last_received_at: c.last_received_at ? new Date(c.last_received_at).toISOString() : null,
      window_open: windowOpen,
      // A verdict only once the window has shut: until then more may still arrive.
      verdict: scenario ? { ...grade(scenario.expect, c.actions), final: !windowOpen, expect: scenario.expect } : null,
    };
  };

  router
    .get('/__mock', () =>
      ok({
        seed: world.seed,
        patients: world.patients.length,
        appointments: world.diary.appointments.length,
        anchors: Object.fromEntries(Object.entries(ANCHORS).map(([k, id]) => [k, world.patient(id)])),
        anchor_appointments: world.anchorAppointments,
        scenarios: cases.map((s) => s.name),
      }),
    { public: true })
    .get('/__mock/scenarios', () => ok({ scenarios: cases }), { public: true })
    .get('/__mock/scenarios/:name', ({ params }) => {
      const s = byName.get(params.name!);
      return s ? ok(s) : fail(404, `no scenario '${params.name}' — try one of ${[...byName.keys()].join(', ')}`);
    }, { public: true })
    .post('/__mock/calls', async ({ body }) => {
      const parsed = await body();
      const b = (parsed.ok ? parsed.value : undefined) as { call_id?: string; scenario?: string; from_number?: string } | undefined;
      if (!b?.call_id) return fail(422, 'call_id is required');
      if (b.scenario && !byName.has(b.scenario)) return fail(422, `no scenario '${b.scenario}'`);
      return ok(view(calls.open(b.call_id, { scenario: b.scenario ?? null, from_number: b.from_number ?? null })));
    }, { public: true })
    .post('/__mock/calls/:call_id/close', ({ params }) => {
      const c = calls.close(params.call_id!);
      return c ? ok(view(c)) : fail(404, `unknown call ${params.call_id}`);
    }, { public: true })
    .get('/__mock/calls', () => ok({ calls: calls.list().map(view) }), { public: true })
    .get('/__mock/calls/:call_id', ({ params }) => {
      const c = calls.get(params.call_id!);
      return c ? ok(view(c)) : fail(404, `unknown call ${params.call_id}`);
    }, { public: true });
}
