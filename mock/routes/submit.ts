/** POST /submit/<action> and GET /submissions — the contract, window and all. */
import { fail, ok, queryError, type Router } from '../http.js';
import type { Calls } from '../submit/calls.js';
import { isRoute, ROUTES, toAction, toValidationDetail } from '../submit/schemas.js';

export function submitRoutes(router: Router, calls: Calls): void {
  router.post('/api/v1/submit/:route', async ({ params, body }) => {
    const route = params.route!;
    if (!isRoute(route)) return fail(404, 'Not Found');

    const parsed = await body();
    if (!parsed.ok) return fail(422, [{ loc: ['body', 0], msg: `JSON decode error: ${parsed.error}`, type: 'json_invalid' }]);

    // A malformed body is 422 and records nothing — checked before the call is looked up.
    const result = ROUTES[route].safeParse(parsed.value ?? {});
    if (!result.success) return fail(422, toValidationDetail(result.error));

    const data = result.data as Record<string, unknown> & { call_id: string };
    const outcome = calls.submit(data.call_id, toAction(route, data));
    if (outcome.status !== 200) return fail(outcome.status, outcome.detail);

    const received_at = new Date(outcome.received_at).toISOString();
    console.log(`[mock] ${data.call_id.slice(0, 8)} ← ${toAction(route, data).action} (${outcome.call.actions.length} on record)`);
    return ok({ call_id: data.call_id, received_at, record: { actions: outcome.call.actions } });
  });

  router.get('/api/v1/submissions', ({ query }) => {
    const raw = query.get('limit') ?? '50';
    const limit = Number(raw);
    if (!Number.isInteger(limit)) return queryError('limit', 'Input should be a valid integer', 'int_parsing');
    if (limit < 1 || limit > 200) return queryError('limit', 'Input should be between 1 and 200', 'less_than_equal');
    return ok({ submissions: calls.records(limit) });
  });
}
