/**
 * The clinic's read endpoints, as call-time lookups.
 *
 * v0 had none of this and therefore could never quote a real slot. Three of these answer
 * about one caller and are called during the call; the catalogue is static for the whole
 * event and is fetched once.
 *
 * Nothing here books: there is no booking endpoint. A decision is reported through
 * `/submit/*` at close, which `submit.ts` owns.
 */

import { z } from 'zod';
import { patientSchema, type Patient } from './schema.js';

export const appointmentSchema = z.object({
  appointment_id: z.string(),
  patient_id: z.string().nullable().optional(),
  provider_id: z.string().nullable().optional(),
  location_id: z.string().nullable().optional(),
  appointment_type_id: z.string().nullable().optional(),
  start_time: z.string(),
  duration_minutes: z.number().nullable().optional(),
});
export type Appointment = z.infer<typeof appointmentSchema>;

export const slotSchema = z.object({
  provider_id: z.string(),
  provider_name: z.string().nullable().optional(),
  specialty_id: z.string().nullable().optional(),
  location_id: z.string(),
  appointment_type_id: z.string(),
  start_time: z.string(),
  duration_minutes: z.number().nullable().optional(),
  /** Which of the patient's plans this slot can be billed against. */
  payable_with: z.array(z.string()).nullable().optional(),
});
export type Slot = z.infer<typeof slotSchema>;

export const availabilitySchema = z.object({
  providers: z.array(z.looseObject({ id: z.string(), name: z.string().nullable().optional() })).default([]),
  /** The one type that fits this patient and specialty. Submit this id, never a guess. */
  appointment_type: z
    .looseObject({ id: z.string(), name: z.string().nullable().optional(), guidance: z.string().nullable().optional() })
    .nullable()
    .optional(),
  slots: z.array(slotSchema).default([]),
  /** The standing rule that stopped a provider — the reason a NO_ACTION should name. */
  blocked: z.array(z.looseObject({ provider_id: z.string().nullable().optional(), restriction: z.string() })).default([]),
});
export type Availability = z.infer<typeof availabilitySchema>;

const hoursSchema = z.array(z.object({ weekday: z.string(), intervals: z.array(z.string()).default([]) })).default([]);

export const locationSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  address: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  hours: hoursSchema,
  provider_names: z.array(z.string()).default([]),
});
export type Location = z.infer<typeof locationSchema>;

export const providerSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  specialty_id: z.string().nullable().optional(),
  specialty_name: z.string().nullable().optional(),
  languages: z.array(z.string()).default([]),
  location_names: z.array(z.string()).default([]),
  refused_insurers: z.array(z.looseObject({ id: z.string() })).default([]),
  leave: z.looseObject({ start: z.string().nullable().optional(), end: z.string().nullable().optional() }).nullable().optional(),
});
export type Provider = z.infer<typeof providerSchema>;

export const catalogueSchema = z.looseObject({
  calendar: z
    .looseObject({
      starts: z.string().nullable().optional(),
      ends: z.string().nullable().optional(),
      max_span_days: z.number().nullable().optional(),
      closure_days: z.array(z.string()).default([]),
    })
    .nullable()
    .optional(),
  providers: z.array(providerSchema).default([]),
  locations: z.array(locationSchema).default([]),
  specialties: z.array(z.looseObject({ id: z.string(), name: z.string() })).default([]),
  appointment_types: z.array(z.looseObject({ id: z.string(), name: z.string() })).default([]),
  plans: z.array(z.looseObject({ id: z.string(), name: z.string() })).default([]),
});
export type Catalogue = z.infer<typeof catalogueSchema>;

export interface ClinicApiOptions {
  baseUrl: string;
  apiKey: string;
  /** Injected so the tests never touch the network. */
  fetch?: typeof globalThis.fetch;
  /** In-call: the caller hears every millisecond of this. */
  timeoutMs?: number;
}

export type AvailabilityQuery = {
  date_from: string;
  date_to: string;
  provider_id?: string;
  specialty_id?: string;
  location_id?: string;
  /** Applies the patient's age, history and plans server-side. Always pass it if known. */
  patient_id?: string;
  /** Repeated. Omit it and the search prices against the single plan on the record. */
  insurer?: string[];
};

export class ClinicApi {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  #catalogue: Promise<Catalogue> | null = null;

  constructor(options: ClinicApiOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  /**
   * Who is calling. An exact field filters rather than downranks, so a misheard id
   * returns nothing — and name plus date_of_birth is what separates two namesakes.
   */
  async findPatient(query: {
    name?: string;
    national_id?: string;
    phone?: string;
    date_of_birth?: string;
  }): Promise<Patient[]> {
    const json = await this.#get('/api/v1/directory', query);
    const parsed = z.object({ matches: z.array(patientSchema).default([]) }).safeParse(json);
    return parsed.success ? parsed.data.matches : [];
  }

  /** The only source of an `appointment_id`. Only an upcoming one can be moved or cancelled. */
  async getPatientAppointments(
    patientId: string,
    when: 'upcoming' | 'past' | 'all' = 'upcoming',
  ): Promise<Appointment[]> {
    const json = await this.#get(`/api/v1/patients/${encodeURIComponent(patientId)}/appointments`, { when });
    const parsed = z.object({ appointments: z.array(appointmentSchema).default([]) }).safeParse(json);
    return parsed.success ? parsed.data.appointments : [];
  }

  /**
   * What they may book and when. Empty `slots` with a populated `blocked` is a rule
   * refusing them; empty with empty `blocked` is a full calendar — different answers.
   */
  async findAvailability(query: AvailabilityQuery): Promise<Availability> {
    const json = await this.#get('/api/v1/availability', query);
    const parsed = availabilitySchema.safeParse(json);
    return parsed.success ? parsed.data : { providers: [], slots: [], blocked: [] };
  }

  /**
   * The catalogue as already fetched elsewhere. `loadClinic` pulls the same document at
   * boot for STT keyterms; priming with its `raw` spends no second request.
   */
  primeCatalogue(raw: unknown): Catalogue | null {
    const parsed = catalogueSchema.safeParse(raw);
    if (!parsed.success) return null;
    this.#catalogue = Promise.resolve(parsed.data);
    return parsed.data;
  }

  /** Generated once and identical all event, so fetched once per process. */
  getCatalogue(): Promise<Catalogue> {
    this.#catalogue ??= this.#get('/api/v1/clinic', {}).then((json) => {
      const parsed = catalogueSchema.safeParse(json);
      if (!parsed.success) throw new Error(`clinic catalogue: ${parsed.error.message}`);
      return parsed.data;
    });
    return this.#catalogue;
  }

  async #get(path: string, query: Record<string, string | string[] | undefined>): Promise<unknown> {
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
    }
    const res = await this.#fetch(url, {
      headers: { 'X-Api-Key': this.#apiKey },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  }
}

// --- catalogue queries ------------------------------------------------------
// Problem 16: the caller acts on whatever we tell them, so a fact we say out loud is
// read off the catalogue and never off the model.

/**
 * A spoken provider name. Two near-miss pairs — Sáez/Sáenz and Iglesias/Iglesia — sit in
 * different specialties, so several hits means ask which, not pick the best.
 */
export function providersByName(catalogue: Catalogue, spoken: string): Provider[] {
  const needle = fold(spoken).replace(/^(dr|dra|d|dna)\.?\s+/, '');
  if (!needle) return [];
  const folded = catalogue.providers.map((p) => ({ p, name: fold(p.name) }));
  const exact = folded.filter(({ name }) => name === needle || name.endsWith(` ${needle}`));
  if (exact.length > 0) return exact.map(({ p }) => p);
  return folded.filter(({ name }) => name.includes(needle)).map(({ p }) => p);
}

export function providersSpeaking(catalogue: Catalogue, language: string): Provider[] {
  const needle = fold(language);
  return catalogue.providers.filter((p) => p.languages.some((l) => fold(l).includes(needle)));
}

export function providerOnLeave(provider: Provider, isoDate: string): boolean {
  const start = provider.leave?.start;
  const end = provider.leave?.end;
  if (!start || !end) return false;
  return isoDate >= start && isoDate <= end;
}

/**
 * The API takes ids, the model says words: "general practice" is a 422, `general_practice`
 * is a diary. Match on the id, the name, or the id with its underscores said as spaces.
 */
export function specialtyByName(catalogue: Catalogue, spoken: string): { id: string; name: string } | undefined {
  const needle = fold(spoken).replace(/[_\s]+/g, ' ');
  if (!needle) return undefined;
  const same = (value: string): boolean => fold(value).replace(/[_\s]+/g, ' ') === needle;
  return catalogue.specialties.find((s) => same(s.id) || same(s.name));
}

export function locationById(catalogue: Catalogue, id: string): Location | undefined {
  const needle = fold(id);
  return catalogue.locations.find((l) => fold(l.id) === needle || fold(l.name).includes(needle));
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The site's published intervals for a date, or `[]` when it is shut that day. */
export function siteHours(catalogue: Catalogue, locationId: string, isoDate: string): string[] {
  if (isClosureDay(catalogue, isoDate)) return [];
  const location = locationById(catalogue, locationId);
  const weekday = WEEKDAYS[new Date(`${isoDate}T12:00:00Z`).getUTCDay()]!;
  return location?.hours.find((h) => fold(h.weekday) === weekday)?.intervals ?? [];
}

export function isClosureDay(catalogue: Catalogue, isoDate: string): boolean {
  return (catalogue.calendar?.closure_days ?? []).includes(isoDate);
}

/** Lower-case, accent-stripped: "Sáenz" and "saenz" are the same spoken name. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
