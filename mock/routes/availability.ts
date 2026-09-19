/** What a patient may book and when — the query side; the rules are in rules/availability.ts. */
import { fail, ok, queryError, type Router } from '../http.js';
import { availability, AvailabilityError } from '../rules/availability.js';
import { INSURERS, type Insurer } from '../world/catalogue.js';
import type { World } from '../world/world.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function availabilityRoutes(router: Router, world: World): void {
  router.get('/api/v1/availability', ({ query }) => {
    for (const name of ['date_from', 'date_to'] as const) {
      const v = query.get(name);
      if (!v) return queryError(name, 'Field required', 'missing');
      if (!ISO_DATE.test(v)) return queryError(name, 'Input should be a valid date in the format YYYY-MM-DD', 'date_from_datetime_parsing');
    }
    const insurers = query.getAll('insurer');
    const bad = insurers.find((i) => !(INSURERS as readonly string[]).includes(i));
    if (bad) return queryError('insurer', `Input should be ${INSURERS.map((i) => `'${i}'`).join(', ')}`, 'enum');

    try {
      return ok(
        availability(
          world,
          {
            date_from: query.get('date_from')!,
            date_to: query.get('date_to')!,
            provider_id: query.get('provider_id') ?? undefined,
            specialty_id: query.get('specialty_id') ?? undefined,
            location_id: query.get('location_id') ?? undefined,
            patient_id: query.get('patient_id') ?? undefined,
            insurer: insurers as Insurer[],
          },
          Date.now(),
        ),
      );
    } catch (err) {
      if (err instanceof AvailabilityError) return fail(422, err.message);
      throw err;
    }
  });
}
