/**
 * The simulated Prosper API over the shared clinic, plus the sim's own routes.
 *
 *   /api/v1/*                       the platform API, same routes and errors — but
 *                                   submissions change the clinic instead of being filed
 *
 *   GET  /__sim                     what is in the clinic right now
 *   GET  /__sim/events?since=<id>   server-sent events: holds, releases, bookings, …
 *   GET  /__sim/holds               live holds
 *   POST /__sim/holds               {call_id, provider_id, location_id, appointment_type_id, start_time, patient_id?, ttl_ms?}
 *   DELETE /__sim/holds/:hold_id    release one (X-Sim-Call-Id or ?call_id must own it)
 *   DELETE /__sim/calls/:call_id/holds  release everything a call holds
 *   POST /__sim/calls               {call_id, from_number?, scenario?} — a call opens
 *   POST /__sim/calls/:call_id/close                                   — its socket closed
 *   GET  /__sim/calls[/:call_id]
 *   GET  /__sim/log[?limit=100]      the newest events, oldest first (the SSE stream's `since` picks up after them)
 *   GET  /__sim/diary?date=YYYY-MM-DD    every provider's day: working, taken and held cells
 *   GET  /__sim/appointments?date=YYYY-MM-DD[&provider_id=]
 *   GET  /__sim/appointments/:appointment_id
 *   POST /__sim/reset               back to the snapshot (?resnapshot=1 to re-copy the live clinic)
 *
 * /__mock/calls and /__mock/calls/:id/close are accepted too, so `pnpm harness -- --prosper`
 * can announce calls here unchanged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fail, ok, queryError, Router, type Reply } from '../mock/http.js';
import { AvailabilityError } from '../mock/rules/availability.js';
import { isRoute, ROUTES, toAction, toValidationDetail } from '../mock/submit/schemas.js';
import { INSURERS, type Insurer } from '../mock/world/catalogue.js';
import { WINDOW_MS, type Clinic, type Outcome, type SimEvent } from './clinic.js';
import type { ProsperClient } from './prosper.js';
import { snapshotFromLive } from './snapshot.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHEN = ['upcoming', 'past', 'all'] as const;

function reply<T>(outcome: Outcome<T>, shape: (value: T) => unknown = (v) => v): Reply {
  return outcome.ok ? ok(shape(outcome.value)) : fail(outcome.status, outcome.detail);
}

export interface SimServerOptions {
  clinic: Clinic;
  live?: ProsperClient | null;
  log?: (line: string) => void;
}

export function buildRouter({ clinic, live, log = () => {} }: SimServerOptions): Router {
  const router = new Router();
  const cat = clinic.catalogue;

  // --- the platform API ------------------------------------------------------

  router
    .get('/api/v1/health', () => ok({ status: 'healthy' }), { public: true })
    .get('/api/openapi.json', () => (clinic.openapi ? ok(clinic.openapi) : fail(404, 'Not Found')), { public: true })
    .get('/api/v1/clinic', () => ok(clinic.clinic()))
    .get('/api/v1/providers', () => ok({ providers: cat.raw.providers }))
    .get('/api/v1/locations', () => ok({ locations: cat.raw.locations }))
    .get('/api/v1/specialties', () => ok({ specialties: cat.raw.specialties }))
    .get('/api/v1/appointment-types', () => ok({ appointment_types: cat.raw.appointment_types }))
    .get('/api/v1/insurance-plans', () => ok({ plans: clinic.clinic().plans }));

  router.get('/api/v1/directory', async ({ query }) => {
    const dob = query.get('date_of_birth') ?? undefined;
    if (dob && !ISO_DATE.test(dob)) {
      return queryError('date_of_birth', 'Input should be a valid date in the format YYYY-MM-DD', 'date_from_datetime_parsing');
    }
    const matches = await clinic.directory({
      name: query.get('name') ?? undefined,
      national_id: query.get('national_id') ?? undefined,
      phone: query.get('phone') ?? undefined,
      date_of_birth: dob,
    });
    if (!matches) return fail(422, 'directory needs at least one of name, national_id, phone or date_of_birth');
    return ok({ matches });
  });

  router.get('/api/v1/patients/:patient_id/appointments', ({ params, query }) => {
    const when = query.get('when') ?? 'upcoming';
    if (!(WHEN as readonly string[]).includes(when)) {
      return queryError('when', `Input should be ${WHEN.map((w) => `'${w}'`).join(', ')}`, 'enum');
    }
    return ok({ appointments: clinic.appointmentsFor(params.patient_id!, when as (typeof WHEN)[number]) });
  });

  router.get('/api/v1/availability', async ({ query, req }) => {
    for (const name of ['date_from', 'date_to'] as const) {
      const v = query.get(name);
      if (!v) return queryError(name, 'Field required', 'missing');
      if (!ISO_DATE.test(v)) return queryError(name, 'Input should be a valid date in the format YYYY-MM-DD', 'date_from_datetime_parsing');
    }
    const insurers = query.getAll('insurer');
    const bad = insurers.find((i) => !(INSURERS as readonly string[]).includes(i));
    if (bad) return queryError('insurer', `Input should be ${INSURERS.map((i) => `'${i}'`).join(', ')}`, 'enum');

    const q = {
      date_from: query.get('date_from')!,
      date_to: query.get('date_to')!,
      provider_id: query.get('provider_id') ?? undefined,
      specialty_id: query.get('specialty_id') ?? undefined,
      location_id: query.get('location_id') ?? undefined,
      patient_id: query.get('patient_id') ?? undefined,
      insurer: insurers as Insurer[],
    };
    // The rules the API hides are learnt from it, once, before we answer for this patient.
    if (q.patient_id && insurers.length > 0) {
      const specialty = q.specialty_id ?? (q.provider_id ? cat.providers.get(q.provider_id)?.specialty_id : undefined);
      if (specialty) await clinic.learnPlanRules(q.patient_id, q.insurer, [specialty]);
    }
    const callId = callIdOf(req, query);
    try {
      return ok(clinic.availability(q, Date.now(), callId));
    } catch (err) {
      if (err instanceof AvailabilityError) return fail(422, err.message);
      throw err;
    }
  });

  router.post('/api/v1/submit/:route', async ({ params, body }) => {
    const route = params.route!;
    if (!isRoute(route)) return fail(404, 'Not Found');
    const parsed = await body();
    if (!parsed.ok) return fail(422, [{ loc: ['body', 0], msg: `JSON decode error: ${parsed.error}`, type: 'json_invalid' }]);
    const result = ROUTES[route].safeParse(parsed.value ?? {});
    if (!result.success) return fail(422, toValidationDetail(result.error));

    const data = result.data as Record<string, unknown> & { call_id: string };
    const action = toAction(route, data);
    const outcome = clinic.submit(route, data, action);
    if (!outcome.ok) {
      log(`${data.call_id.slice(0, 8)} ← ${action.action} refused ${outcome.status}: ${outcome.detail}`);
      return fail(outcome.status, outcome.detail);
    }
    const received_at = new Date(outcome.value.call.last_received_at!).toISOString();
    log(`${data.call_id.slice(0, 8)} ← ${action.action} applied (${outcome.value.actions.length} on record)`);
    return ok({ call_id: data.call_id, received_at, record: { actions: outcome.value.actions }, ...outcome.value.result });
  });

  router.get('/api/v1/submissions', ({ query }) => {
    const raw = query.get('limit') ?? '50';
    const limit = Number(raw);
    if (!Number.isInteger(limit)) return queryError('limit', 'Input should be a valid integer', 'int_parsing');
    if (limit < 1 || limit > 200) return queryError('limit', 'Input should be between 1 and 200', 'less_than_equal');
    return ok({ submissions: clinic.records(limit) });
  });

  // --- the sim's own ------------------------------------------------------------

  const callView = (callId: string): Reply => {
    const c = clinic.call(callId);
    if (!c) return fail(404, `unknown call ${callId}`);
    return ok({
      ...c,
      opened_at: new Date(c.opened_at).toISOString(),
      closed_at: c.closed_at ? new Date(c.closed_at).toISOString() : null,
      last_received_at: c.last_received_at ? new Date(c.last_received_at).toISOString() : null,
      window_open: c.closed_at === null || Date.now() - c.closed_at <= WINDOW_MS,
      actions: clinic.actions(callId),
      holds: clinic.holds().filter((h) => h.call_id === callId),
    });
  };

  const openCall = async ({ body }: { body: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }> }): Promise<Reply> => {
    const parsed = await body();
    const b = (parsed.ok ? parsed.value : undefined) as { call_id?: string; scenario?: string; from_number?: string } | undefined;
    if (!b?.call_id) return fail(422, 'call_id is required');
    clinic.openCall(b.call_id, { scenario: b.scenario ?? null, from_number: b.from_number ?? null });
    return callView(b.call_id);
  };
  const closeCall = ({ params }: { params: Record<string, string> }): Reply => {
    const c = clinic.closeCall(params.call_id!);
    return c ? callView(c.call_id) : fail(404, `unknown call ${params.call_id}`);
  };

  router
    .get('/__sim', () => ok(clinic.state()), { public: true })
    .get('/__sim/holds', () => ok({ holds: clinic.holds() }), { public: true })
    .post(
      '/__sim/holds',
      async ({ body }) => {
        const parsed = await body();
        const b = (parsed.ok ? parsed.value : undefined) as Partial<Record<string, unknown>> | undefined;
        const need = ['call_id', 'provider_id', 'location_id', 'appointment_type_id', 'start_time'] as const;
        const gap = need.find((k) => typeof b?.[k] !== 'string' || (b[k] as string).length === 0);
        if (gap) return fail(422, `${gap} is required`);
        return reply(
          clinic.hold({
            call_id: b!.call_id as string,
            provider_id: b!.provider_id as string,
            location_id: b!.location_id as string,
            appointment_type_id: b!.appointment_type_id as string,
            start_time: b!.start_time as string,
            patient_id: typeof b!.patient_id === 'string' ? b!.patient_id : undefined,
            ttl_ms: typeof b!.ttl_ms === 'number' ? b!.ttl_ms : undefined,
          }),
        );
      },
      { public: true },
    )
    .add('DELETE', '/__sim/holds/:hold_id', ({ params, req, query }) => reply(clinic.release(params.hold_id!, callIdOf(req, query))), { public: true })
    .add('DELETE', '/__sim/calls/:call_id/holds', ({ params }) => ok({ released: clinic.releaseAll(params.call_id!) }), { public: true })
    .post('/__sim/calls', openCall, { public: true })
    .post('/__sim/calls/:call_id/close', closeCall, { public: true })
    .post('/__mock/calls', openCall, { public: true })
    .post('/__mock/calls/:call_id/close', closeCall, { public: true })
    .get('/__mock/calls/:call_id', ({ params }) => callView(params.call_id!), { public: true })
    .get('/__sim/calls', () => ok({ calls: clinic.calls() }), { public: true })
    .get('/__sim/calls/:call_id', ({ params }) => callView(params.call_id!), { public: true })
    .get(
      '/__sim/appointments',
      ({ query }) => {
        const date = query.get('date');
        if (!date || !ISO_DATE.test(date)) return fail(422, 'date=YYYY-MM-DD is required');
        return ok({ appointments: clinic.appointmentsOn(date, query.get('provider_id') ?? undefined) });
      },
      { public: true },
    )
    .get(
      '/__sim/log',
      ({ query }) => {
        const limit = Math.min(Math.max(Number(query.get('limit') ?? 100) || 100, 1), 1000);
        return ok({ events: clinic.recentEvents(limit) });
      },
      { public: true },
    )
    .get(
      '/__sim/diary',
      ({ query }) => {
        const date = query.get('date');
        if (!date || !ISO_DATE.test(date)) return fail(422, 'date=YYYY-MM-DD is required');
        return ok(clinic.diary(date));
      },
      { public: true },
    )
    .get('/__sim/appointments/:appointment_id', ({ params }) => {
      const a = clinic.appointment(params.appointment_id!);
      return a ? ok(a) : fail(404, `unknown appointment ${params.appointment_id}`);
    }, { public: true })
    .post(
      '/__sim/reset',
      async ({ query }) => {
        if (query.get('resnapshot') === '1') {
          if (!live?.configured) return fail(409, 'no live API configured to re-snapshot from');
          await snapshotFromLive(clinic.db, live, log);
          clinic.reloadSnapshot();
          return ok({ reset: true, resnapshot: true, ...clinic.state() });
        }
        clinic.reset();
        return ok({ reset: true, ...clinic.state() });
      },
      { public: true },
    );

  return router;
}

/** The call a request speaks for, if it says: a header or a query parameter. */
function callIdOf(req: IncomingMessage, query: URLSearchParams): string | null {
  const header = req.headers['x-sim-call-id'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return fromHeader ?? query.get('call_id');
}

/** Server-sent events. `?since=<id>` replays what was missed; then it is live. */
function streamEvents(clinic: Clinic, req: IncomingMessage, res: ServerResponse, url: URL): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const send = (e: SimEvent): void => {
    res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const since = Number(url.searchParams.get('since') ?? req.headers['last-event-id'] ?? NaN);
  let last = 0;
  if (Number.isFinite(since)) {
    for (const e of clinic.eventsSince(since)) {
      send(e);
      last = e.id;
    }
  }
  const onEvent = (e: SimEvent): void => {
    if (e.id > last) {
      last = e.id;
      send(e);
    }
  };
  clinic.on('event', onEvent);
  const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(beat);
    clinic.off('event', onEvent);
  });
}

export function createSimServer(options: SimServerOptions): Server {
  const router = buildRouter(options);
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://sim');
    if (req.method === 'GET' && url.pathname === '/__sim/events') {
      streamEvents(options.clinic, req, res, url);
      return;
    }
    void router.handle(req, res);
  });
}
