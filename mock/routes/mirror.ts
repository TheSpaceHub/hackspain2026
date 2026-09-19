/**
 * Mirror mode: reads come from the real Prosper, writes never leave the machine.
 *
 * A case built on the real clinic expects a real patient, a real provider and a
 * slot that exists — so the agent has to be able to look those up. It reads them
 * upstream, and the one thing that would count against the practice, submitting
 * an action, still lands in the local Calls ledger and is graded there.
 *
 * Registered before the invented-world routes, so it wins the GETs it covers;
 * POST /api/v1/calls/... is deliberately not among them.
 */
import { fail, type Reply, type Router } from '../http.js';

const TIMEOUT_MS = 20_000;

export function mirrorRoutes(router: Router, base: string, key: string): void {
  router.addPattern('GET', /^\/api\/v1\/.*$/, async ({ url }): Promise<Reply> => {
    const target = `${base.replace(/\/$/, '')}${url.pathname}${url.search}`;
    try {
      const res = await fetch(target, {
        headers: { 'X-Api-Key': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    } catch (err) {
      return fail(502, `mirror: ${url.pathname} → ${String(err)}`);
    }
  });
}
