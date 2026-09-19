/**
 * A thin read-only client for the live Prosper API, used to build cases out of the real
 * clinic rather than the invented one. Only the read endpoints: nothing here submits.
 */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

export interface RealPatient {
  patient_id: string;
  given_name: string;
  first_surname: string;
  second_surname: string;
  national_id: string;
  date_of_birth: string;
  phone: string;
  sex: 'F' | 'M';
  has_visited_before: boolean;
  insurer: string;
  referrals: string[];
  note: string;
}

export interface RealSlot {
  provider_id: string;
  provider_name?: string | null;
  specialty_id?: string | null;
  location_id: string;
  appointment_type_id: string;
  start_time: string;
  duration_minutes?: number | null;
  payable_with?: string[] | null;
}

export interface RealAvailability {
  providers: { id: string; name?: string | null }[];
  appointment_type?: { id: string; name?: string | null } | null;
  slots: RealSlot[];
  blocked: { provider_id?: string | null; restriction: string }[];
}

export interface RealAppointment {
  appointment_id: string;
  patient_id?: string | null;
  provider_id?: string | null;
  location_id?: string | null;
  appointment_type_id?: string | null;
  start_time: string;
  duration_minutes?: number | null;
}

export interface AvailabilityQuery {
  date_from: string;
  date_to: string;
  patient_id?: string;
  specialty_id?: string;
  provider_id?: string;
  location_id?: string;
  insurer?: string[];
}

export class RealClinic {
  readonly #base: string;
  readonly #key: string;

  constructor(base = process.env.PROSPER_API_BASE_URL, key = process.env.PROSPER_API_KEY) {
    if (!base || !key) throw new Error('real clinic needs PROSPER_API_BASE_URL and PROSPER_API_KEY');
    this.#base = base.replace(/\/+$/, '');
    this.#key = key;
  }

  clinic(): Promise<Record<string, unknown>> {
    return this.#get('/api/v1/clinic', {}) as Promise<Record<string, unknown>>;
  }

  async providers(): Promise<Record<string, unknown>[]> {
    const json = (await this.#get('/api/v1/providers', {})) as { providers?: Record<string, unknown>[] };
    return json.providers ?? [];
  }

  async locations(): Promise<Record<string, unknown>[]> {
    const json = (await this.#get('/api/v1/locations', {})) as { locations?: Record<string, unknown>[] };
    return json.locations ?? [];
  }

  async specialties(): Promise<Record<string, unknown>[]> {
    const json = (await this.#get('/api/v1/specialties', {})) as { specialties?: Record<string, unknown>[] };
    return json.specialties ?? [];
  }

  /** The directory refuses an open query, so a birthday is the only way to meet strangers. */
  async patientsBornOn(date: string): Promise<RealPatient[]> {
    const json = (await this.#get('/api/v1/directory', { date_of_birth: date })) as { matches?: RealPatient[] };
    return json.matches ?? [];
  }

  async findPatient(query: { name?: string; national_id?: string; phone?: string }): Promise<RealPatient[]> {
    const json = (await this.#get('/api/v1/directory', query)) as { matches?: RealPatient[] };
    return json.matches ?? [];
  }

  async appointments(patientId: string, when: 'upcoming' | 'past' | 'all' = 'upcoming'): Promise<RealAppointment[]> {
    const json = (await this.#get(`/api/v1/patients/${encodeURIComponent(patientId)}/appointments`, { when })) as {
      appointments?: RealAppointment[];
    };
    return json.appointments ?? [];
  }

  async availability(query: AvailabilityQuery): Promise<RealAvailability> {
    const json = (await this.#get('/api/v1/availability', { ...query })) as RealAvailability;
    return {
      providers: json.providers ?? [],
      appointment_type: json.appointment_type ?? null,
      slots: json.slots ?? [],
      blocked: json.blocked ?? [],
    };
  }

  async #get(path: string, query: Record<string, string | string[] | undefined>): Promise<unknown> {
    const url = new URL(this.#base + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(key, one);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { 'X-Api-Key': this.#key }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return res.json();
      if (res.status === 429 && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`${path} ${res.status}`);
    }
  }
}
