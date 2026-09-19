/** Who is calling, and what is in their diary. */
import { fail, ok, queryError, type Router } from '../http.js';
import { searchDirectory } from '../rules/directory.js';
import type { World } from '../world/world.js';

const WHEN = ['upcoming', 'past', 'all'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function patientRoutes(router: Router, world: World): void {
  router.get('/api/v1/directory', ({ query }) => {
    const dob = query.get('date_of_birth') ?? undefined;
    if (dob && !ISO_DATE.test(dob)) {
      return queryError('date_of_birth', 'Input should be a valid date in the format YYYY-MM-DD', 'date_from_datetime_parsing');
    }
    const matches = searchDirectory(world.patients, {
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
    const now = Date.now();
    // The only source of an appointment_id. Past visits are there to be read back, never moved.
    const appointments = world.diary.forPatient(params.patient_id!).filter((a) => {
      const past = Date.parse(a.start_time) < now;
      return when === 'all' || (when === 'past' ? past : !past);
    });
    return ok({ appointments });
  });
}
