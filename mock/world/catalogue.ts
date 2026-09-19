/**
 * The clinic's fixed catalogue: sites, specialties, providers, appointment types,
 * plans and standing restrictions.
 *
 * This part is NOT invented. It is a snapshot of the real /api/v1/clinic — public,
 * identical for every team — because the agent hard-codes facts about it (the
 * decider knows Dra. Iglesias refuses DKV, that the physio sits at Sur). A mock
 * that moved the doctors around would make those facts false and every test
 * misleading. The people and their diaries are what the mock invents; see people.ts.
 */
import { readFileSync } from 'node:fs';

export interface InsurerRef {
  id: string;
  name: string;
}
export interface Day {
  weekday: string;
  intervals: string[];
}
export interface Provider {
  id: string;
  name: string;
  specialty_id: string;
  specialty_name: string;
  languages: string[];
  appointment_type_names: string[];
  location_names: string[];
  schedules: { location_id: string; location_name: string; days: Day[] }[];
  accepted_insurers: InsurerRef[];
  refused_insurers: InsurerRef[];
  leave: { start: string; end: string; reason: string } | null;
}
export interface Specialty {
  id: string;
  name: string;
  min_age_months: number;
  max_age_months: number | null;
  referral_required: boolean;
  provider_names: string[];
  covered_by: InsurerRef[];
  not_covered_by: InsurerRef[];
}
export interface AppointmentType {
  id: string;
  name: string;
  duration_minutes: number;
  new_patient_requirement: 'new_only' | 'existing_only' | string;
  guidance: string;
  provider_names: string[];
  specialty_id: string | null;
  specialty_name: string | null;
}
export interface Location {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  hours: Day[];
  provider_names: string[];
  covered_by: InsurerRef[];
  not_covered_by: InsurerRef[];
}
export interface Plan {
  id: string;
  name: string;
  covered_specialty_names: string[];
  uncovered_specialty_names: string[];
  covered_location_names: string[];
  uncovered_location_names: string[];
  accepted_by: string[];
  refused_by: string[];
}
export interface Restriction {
  id: string;
  title: string;
  explanation: string;
}
export interface CatalogueSnapshot {
  clinic_name: string;
  calendar: {
    starts: string;
    ends: string;
    max_span_days: number;
    slot_minutes: number;
    closure_days: string[];
  };
  restrictions: Restriction[];
  providers: Provider[];
  specialties: Specialty[];
  appointment_types: AppointmentType[];
  locations: Location[];
  plans: Plan[];
}

export const INSURERS = [
  'sanitas', 'adeslas', 'dkv', 'asisa', 'mapfre', 'caser', 'cigna', 'axa', 'nueva_mutua', 'privado',
] as const;
export type Insurer = (typeof INSURERS)[number];

/**
 * The two plan rules the catalogue names but does not spell out. Invented, and
 * documented here so a test can be written against them:
 *
 * - An insurer that demands its own referral for a specialty the clinic does not
 *   gate — the same appointment bookable for one patient and not another.
 * - A yearly visit cap. What a patient has spent lives on their record (people.ts),
 *   never in their visit history, which is deliberately older than this year.
 */
export const INSURER_REFERRALS: Partial<Record<Insurer, string[]>> = {
  axa: ['orthopaedics'],
  cigna: ['gynaecology'],
};
export const ALLOWANCE_CAPS: Partial<Record<Insurer, Record<string, number>>> = {
  mapfre: { orthopaedics: 4 },
  cigna: { physiotherapy: 6 },
  axa: { physiotherapy: 8 },
};

const snapshot = JSON.parse(
  readFileSync(new URL('./catalogue.json', import.meta.url), 'utf8'),
) as CatalogueSnapshot;

export class Catalogue {
  readonly raw: CatalogueSnapshot;
  readonly providers: Map<string, Provider>;
  readonly specialties: Map<string, Specialty>;
  readonly types: Map<string, AppointmentType>;
  readonly locations: Map<string, Location>;
  readonly plans: Map<string, Plan>;
  readonly #typeByName: Map<string, AppointmentType>;

  /** The bundled snapshot by default; the sim passes one fetched from the live API. */
  constructor(raw: CatalogueSnapshot = snapshot) {
    this.raw = raw;
    this.providers = new Map(raw.providers.map((p) => [p.id, p]));
    this.specialties = new Map(raw.specialties.map((s) => [s.id, s]));
    this.types = new Map(raw.appointment_types.map((t) => [t.id, t]));
    this.locations = new Map(raw.locations.map((l) => [l.id, l]));
    this.plans = new Map(raw.plans.map((p) => [p.id, p]));
    this.#typeByName = new Map(raw.appointment_types.map((t) => [t.name, t]));
  }

  get calendar(): CatalogueSnapshot['calendar'] {
    return this.raw.calendar;
  }

  providersOf(specialtyId: string): Provider[] {
    return this.raw.providers.filter((p) => p.specialty_id === specialtyId);
  }

  /** The ids of the types a provider performs; the catalogue lists them by name. */
  typesOf(provider: Provider): Set<string> {
    return new Set(provider.appointment_type_names.flatMap((n) => this.#typeByName.get(n)?.id ?? []));
  }

  /**
   * Exactly one type fits a booking, and it follows the record, never the request:
   * the specialty's own type wins over the universal pair, and history picks which.
   */
  typeFor(specialtyId: string, hasVisitedBefore: boolean): AppointmentType {
    const want = hasVisitedBefore ? 'existing_only' : 'new_only';
    const own = this.raw.appointment_types.find(
      (t) => t.specialty_id === specialtyId && t.new_patient_requirement === want,
    );
    return own ?? this.types.get(hasVisitedBefore ? 'review' : 'first_visit')!;
  }

  planCoversSpecialty(planId: string, specialtyId: string): boolean {
    return !this.specialties.get(specialtyId)?.not_covered_by.some((i) => i.id === planId);
  }

  planCoversLocation(planId: string, locationId: string): boolean {
    return !this.locations.get(locationId)?.not_covered_by.some((i) => i.id === planId);
  }

  providerTakes(provider: Provider, planId: string): boolean {
    return provider.accepted_insurers.some((i) => i.id === planId);
  }
}

export const catalogue = new Catalogue();
