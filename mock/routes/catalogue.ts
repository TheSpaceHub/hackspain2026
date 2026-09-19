/**
 * The catalogue routes. Fixed data, served as-is — except the counts, which come
 * from the invented world rather than the real one.
 */
import { readFileSync } from 'node:fs';
import { ok, type Router } from '../http.js';
import type { World } from '../world/world.js';

const openapi = JSON.parse(readFileSync(new URL('../world/openapi.json', import.meta.url), 'utf8')) as unknown;

export function catalogueRoutes(router: Router, world: World): void {
  const { raw, calendar } = world.catalogue;

  const holders = (planId: string): number => world.patients.filter((p) => p.insurer === planId).length;
  const plans = raw.plans.map((p) => ({ ...p, holders: holders(p.id) }));
  const appointmentCount = world.diary.appointments.filter((a) => a.start_time.slice(0, 10) >= calendar.starts).length;

  router
    .get('/api/v1/health', () => ok({ status: 'healthy' }), { public: true })
    .get('/api/openapi.json', () => ok(openapi), { public: true })
    .get('/api/v1/clinic', () =>
      ok({
        clinic_name: raw.clinic_name,
        patient_count: world.patients.length,
        calendar: { ...calendar, appointment_count: appointmentCount },
        restrictions: raw.restrictions,
        providers: raw.providers,
        specialties: raw.specialties,
        appointment_types: raw.appointment_types,
        locations: raw.locations,
        plans,
      }),
    )
    .get('/api/v1/providers', () => ok({ providers: raw.providers }))
    .get('/api/v1/locations', () => ok({ locations: raw.locations }))
    .get('/api/v1/specialties', () => ok({ specialties: raw.specialties }))
    .get('/api/v1/appointment-types', () => ok({ appointment_types: raw.appointment_types }))
    .get('/api/v1/insurance-plans', () => ok({ plans }));
}
