/**
 * The live Prosper API, read-only — the source the clinic is copied from. Every call
 * here is a GET; nothing the sim does ever reaches the real clinic.
 */
import type { CatalogueSnapshot } from '../mock/world/catalogue.js';
import type { AvailabilityResponse } from '../mock/rules/availability.js';
import type { PatientMatch } from '../mock/rules/directory.js';
import type { Appointment } from '../mock/world/diary.js';

export interface ClinicBody extends CatalogueSnapshot {
  patient_count: number;
  calendar: CatalogueSnapshot['calendar'] & { appointment_count: number };
  plans: (CatalogueSnapshot['plans'][number] & { holders: number })[];
}

export class ProsperError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
    message: string,
  ) {
    super(message);
  }
}

export interface ProsperClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class ProsperClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: ProsperClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  get configured(): boolean {
    return this.#apiKey.length > 0;
  }

  async get<T>(path: string, query: Record<string, string | string[] | undefined> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
    }
    const res = await this.#fetch(url, {
      headers: { 'X-Api-Key': this.#apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const detail = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : body;
      throw new ProsperError(res.status, detail, `${path} → ${res.status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
    return body as T;
  }

  clinic(): Promise<ClinicBody> {
    return this.get('/api/v1/clinic');
  }

  openapi(): Promise<unknown> {
    return this.get('/api/openapi.json');
  }

  availability(q: {
    date_from: string;
    date_to: string;
    provider_id?: string;
    specialty_id?: string;
    location_id?: string;
    patient_id?: string;
    insurer?: string[];
  }): Promise<AvailabilityResponse> {
    return this.get('/api/v1/availability', q);
  }

  directory(q: { name?: string; national_id?: string; phone?: string; date_of_birth?: string }): Promise<{ matches: PatientMatch[] }> {
    return this.get('/api/v1/directory', q);
  }

  appointments(patientId: string, when: 'upcoming' | 'past' | 'all'): Promise<{ appointments: Appointment[] }> {
    return this.get(`/api/v1/patients/${encodeURIComponent(patientId)}/appointments`, { when });
  }
}
