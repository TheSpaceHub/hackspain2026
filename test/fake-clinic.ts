/**
 * A Prosper stand-in: the read API, in memory, behind a `fetch`-shaped function.
 *
 * The real endpoints are rate-limited, shared with everyone else at the event, and
 * cannot be made to produce the case you want to test — a patient with two policies, a
 * restriction that bites, a diary with exactly one slot left. This can, deterministically
 * and offline, so the tool layer is regression-tested without a call or a key.
 *
 * It mirrors the documented shapes only: anything the client parses, it returns.
 */

import { createServer, type Server } from 'node:http';

export interface FakePatient {
  patient_id: string;
  given_name: string;
  first_surname: string;
  second_surname?: string;
  national_id?: string;
  date_of_birth?: string;
  phone?: string;
  has_visited_before: boolean;
  insurer?: string;
}

const CATALOGUE = {
  calendar: {
    starts: '2026-10-05',
    ends: '2026-11-30',
    slot_minutes: 30,
    max_span_days: 14,
    closure_days: ['2026-10-12'],
  },
  providers: [
    {
      id: 'prov_saez',
      name: 'Dra. Marta Sáez',
      specialty_id: 'spec_gp',
      specialty_name: 'general practice',
      languages: ['Spanish', 'English'],
      location_names: ['Arenal Centro'],
      refused_insurers: [],
      leave: null,
    },
    {
      id: 'prov_saenz',
      name: 'Dr. Julio Sáenz',
      specialty_id: 'spec_derm',
      specialty_name: 'dermatology',
      languages: ['Spanish'],
      location_names: ['Arenal Norte'],
      refused_insurers: [],
      leave: { start: '2026-10-19', end: '2026-10-26' },
    },
    {
      id: 'prov_iglesias',
      name: 'Dra. Elena Iglesias',
      specialty_id: 'spec_derm',
      specialty_name: 'dermatology',
      languages: ['Spanish'],
      location_names: ['Arenal Norte'],
      refused_insurers: [],
      leave: null,
    },
    {
      id: 'prov_cid',
      name: 'D. Álvaro Cid',
      specialty_id: 'spec_physio',
      specialty_name: 'physiotherapy',
      languages: ['Spanish'],
      location_names: ['Arenal Sur'],
      refused_insurers: [{ id: 'asisa' }],
      leave: null,
    },
  ],
  locations: [
    {
      id: 'loc_centro',
      name: 'Arenal Centro',
      address: 'Calle del Arenal 12, Madrid',
      latitude: 40.4169,
      longitude: -3.7075,
      hours: [
        { weekday: 'monday', intervals: ['08:00-20:00'] },
        { weekday: 'saturday', intervals: ['09:00-14:00'] },
      ],
      provider_names: ['Dra. Marta Sáez'],
    },
    {
      id: 'loc_norte',
      name: 'Arenal Norte',
      address: 'Calle de Bravo Murillo 200, Madrid',
      latitude: 40.4631,
      longitude: -3.7038,
      hours: [{ weekday: 'monday', intervals: ['08:00-20:00'] }],
      provider_names: ['Dr. Julio Sáenz', 'Dra. Elena Iglesias'],
    },
    {
      id: 'loc_sur',
      name: 'Arenal Sur',
      address: 'Calle de Embajadores 180, Madrid',
      latitude: 40.3901,
      longitude: -3.7016,
      hours: [{ weekday: 'monday', intervals: ['08:00-15:00'] }],
      provider_names: ['D. Álvaro Cid'],
    },
  ],
  specialties: [
    { id: 'spec_gp', name: 'general practice' },
    { id: 'spec_derm', name: 'dermatology' },
    { id: 'spec_physio', name: 'physiotherapy' },
  ],
  appointment_types: [
    { id: 'apt_first', name: 'first visit' },
    { id: 'apt_review', name: 'review' },
  ],
  plans: [
    { id: 'sanitas', name: 'Sanitas' },
    { id: 'asisa', name: 'ASISA' },
    { id: 'adeslas', name: 'Adeslas' },
  ],
};

const PATIENTS: FakePatient[] = [
  {
    patient_id: 'pat_001',
    given_name: 'Marta',
    first_surname: 'Ruiz',
    second_surname: 'Ortega',
    national_id: '12345678Z',
    date_of_birth: '1985-03-14',
    phone: '600111222',
    has_visited_before: true,
    insurer: 'sanitas',
  },
  {
    patient_id: 'pat_002',
    given_name: 'Joaquín',
    first_surname: 'González',
    second_surname: 'Ortega',
    national_id: '48064716Y',
    date_of_birth: '1971-11-02',
    phone: '600333444',
    has_visited_before: false,
    insurer: 'asisa',
  },
  // Two people, one household line: a phone match alone must not identify either.
  {
    patient_id: 'pat_003',
    given_name: 'Luis',
    first_surname: 'González',
    date_of_birth: '2015-06-01',
    phone: '600333444',
    has_visited_before: true,
    insurer: 'asisa',
  },
];

const APPOINTMENTS = [
  {
    appointment_id: 'apt_9001',
    patient_id: 'pat_001',
    provider_id: 'prov_saez',
    location_id: 'loc_centro',
    appointment_type_id: 'apt_review',
    start_time: '2026-10-20T09:00:00+02:00',
    duration_minutes: 30,
  },
];

export interface FakeClinicOptions {
  /** Days with no diary at all, on top of the published closure. */
  fullDays?: string[];
  /** Override the default diary times for clock-constraint tests. */
  slotTimes?: { hour: number; minute?: number }[];
  /** Restriction returned instead of slots, e.g. for an insurer a provider refuses. */
  restriction?: { provider_id?: string; restriction: string };
}

/** The exact times the diary will offer, so a test can assert on the string submitted. */
const SLOT_HOURS = [9, 11, 16];

export class FakeClinic {
  readonly requests: { path: string; query: Record<string, string[]> }[] = [];
  #options: FakeClinicOptions;

  constructor(options: FakeClinicOptions = {}) {
    this.#options = options;
  }

  /** Drop-in for `globalThis.fetch`; pass it to `new ClinicApi({ fetch })`. */
  readonly fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const query: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams) (query[k] ??= []).push(v);
    this.requests.push({ path: url.pathname, query });

    const body = this.route(url.pathname, query);
    if (body === null) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  route(path: string, query: Record<string, string[]>): unknown {
    const one = (key: string): string | undefined => query[key]?.[0];

    if (path === '/api/v1/clinic') return CATALOGUE;

    if (path === '/api/v1/directory') {
      // Exact fields filter; a name is matched loosely, the way the real one scores it.
      const matches = PATIENTS.filter((p) => {
        if (one('national_id') && p.national_id !== one('national_id')) return false;
        if (one('phone') && p.phone !== one('phone')) return false;
        if (one('date_of_birth') && p.date_of_birth !== one('date_of_birth')) return false;
        const name = one('name');
        if (name) {
          const full = `${p.given_name} ${p.first_surname} ${p.second_surname ?? ''}`.toLowerCase();
          const parts = name.toLowerCase().split(/\s+/).filter(Boolean);
          if (!parts.every((part) => full.includes(part))) return false;
        }
        return true;
      });
      return { matches: matches.map((p) => ({ ...p, match_score: 1, matched_fields: Object.keys(query) })) };
    }

    const appointments = /^\/api\/v1\/patients\/([^/]+)\/appointments$/.exec(path);
    if (appointments) {
      const patientId = decodeURIComponent(appointments[1]!);
      return { appointments: APPOINTMENTS.filter((a) => a.patient_id === patientId) };
    }

    if (path === '/api/v1/availability') return this.#availability(query);

    return null;
  }

  #availability(query: Record<string, string[]>): unknown {
    const from = query.date_from?.[0] ?? '';
    const to = query.date_to?.[0] ?? from;
    const providerId = query.provider_id?.[0];
    const specialtyId = query.specialty_id?.[0];
    const locationId = query.location_id?.[0];
    const patientId = query.patient_id?.[0];
    const insurers = query.insurer ?? [];

    if (
      this.#options.restriction &&
      (!this.#options.restriction.provider_id || this.#options.restriction.provider_id === providerId)
    ) {
      return { providers: [], appointment_type: null, slots: [], blocked: [this.#options.restriction] };
    }

    let providers = CATALOGUE.providers;
    if (this.#options.restriction?.provider_id && providerId !== this.#options.restriction.provider_id) {
      providers = providers.filter((p) => p.id !== this.#options.restriction!.provider_id);
    }
    if (providerId) providers = providers.filter((p) => p.id === providerId);
    if (specialtyId) providers = providers.filter((p) => p.specialty_id === specialtyId);
    if (locationId) {
      const site = CATALOGUE.locations.find((l) => l.id === locationId);
      providers = providers.filter((p) => site?.provider_names.includes(p.name));
    }
    // The published interaction: ASISA is not taken by the physiotherapist.
    const refused = providers.filter((p) =>
      p.refused_insurers.some((r) => insurers.includes(r.id)),
    );
    providers = providers.filter((p) => !refused.includes(p));
    if (providers.length === 0) {
      return {
        providers: [],
        appointment_type: null,
        slots: [],
        blocked: refused.map((p) => ({
          provider_id: p.id,
          restriction: `${p.name} does not accept ${insurers.join(', ')}`,
        })),
      };
    }

    const patient = PATIENTS.find((p) => p.patient_id === patientId);
    const type = patient?.has_visited_before
      ? { id: 'apt_review', name: 'review' }
      : { id: 'apt_first', name: 'first visit' };

    const slots = [];
    for (const date of datesBetween(from, to)) {
      if (CATALOGUE.calendar.closure_days.includes(date)) continue;
      if (this.#options.fullDays?.includes(date)) continue;
      for (const provider of providers) {
        const site = CATALOGUE.locations.find((l) => l.provider_names.includes(provider.name));
        const times = this.#options.slotTimes ??
          SLOT_HOURS.map((hour): { hour: number; minute?: number } => ({ hour }));
        for (const time of times) {
          const hour = time.hour;
          const minute = time.minute ?? 0;
          slots.push({
            provider_id: provider.id,
            provider_name: provider.name,
            specialty_id: provider.specialty_id,
            location_id: site?.id ?? 'loc_centro',
            appointment_type_id: type.id,
            start_time: `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+02:00`,
            duration_minutes: 30,
            payable_with: insurers.length > 0 ? insurers : [patient?.insurer ?? 'privado'],
          });
        }
      }
    }

    return {
      providers: providers.map((p) => ({ id: p.id, name: p.name })),
      appointment_type: type,
      slots,
      blocked: [],
    };
  }

  /** The same clinic over HTTP, for running the whole server offline. */
  listen(port = 0): Promise<{ server: Server; baseUrl: string }> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const query: Record<string, string[]> = {};
      for (const [k, v] of url.searchParams) (query[k] ??= []).push(v);
      this.requests.push({ path: url.pathname, query });
      const body = this.route(url.pathname, query);
      if (body === null) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
    return new Promise((resolve) => {
      server.listen(port, () => {
        const address = server.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        resolve({ server, baseUrl: `http://127.0.0.1:${bound}` });
      });
    });
  }
}

export const fakeCatalogue = CATALOGUE;
export const fakePatients = PATIENTS;
export const fakeAppointments = APPOINTMENTS;

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = from; d <= to && dates.length < 20; d = nextDay(d)) dates.push(d);
  return dates;
}

function nextDay(isoDate: string): string {
  const at = new Date(`${isoDate}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}
