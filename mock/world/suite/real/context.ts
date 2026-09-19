/**
 * The real clinic as a case-writing surface.
 *
 * Same idea as the generated suite's helpers — ask the source of truth what it will do,
 * then write that answer down as the expectation — except the source of truth is the
 * live platform. Every answer is memoised, so a suite of eighty cases costs a few
 * hundred requests once and nothing afterwards.
 */
import { addDays, todayMadrid } from '../../../rules/time.js';
import { RealClinic, type RealAvailability, type RealSlot } from '../../../../testlab/real/client.js';
import type { HarvestedPatient, Snapshot } from '../../../../testlab/real/harvest.js';
import type { ExpectedAction, Matcher } from '../types.js';

export interface Query {
  specialty?: string;
  provider?: string;
  location?: string;
  patient?: HarvestedPatient;
  insurer?: string[];
  from?: string;
  to?: string;
}

export interface Found {
  slot: RealSlot;
  /** Everything starting on the same minute — any of them is a right answer. */
  tied: RealSlot[];
}

export class RealWorld {
  readonly snapshot: Snapshot;
  readonly #clinic: RealClinic;
  readonly #cache = new Map<string, Promise<RealAvailability>>();

  constructor(snapshot: Snapshot, clinic = new RealClinic()) {
    this.snapshot = snapshot;
    this.#clinic = clinic;
  }

  get calendarEnds(): string {
    const calendar = this.snapshot.clinic.calendar as { ends?: string } | undefined;
    return calendar?.ends ?? addDays(todayMadrid(), 14);
  }

  get closureDays(): string[] {
    const calendar = this.snapshot.clinic.calendar as { closure_days?: string[] } | undefined;
    return calendar?.closure_days ?? [];
  }

  /** Nothing is booked same-day, and the search may not span more than a fortnight. */
  from(): string {
    return addDays(todayMadrid(), 1);
  }

  to(from = this.from(), days = 13): string {
    const end = addDays(from, days);
    return end > this.calendarEnds ? this.calendarEnds : end;
  }

  /** Any day the calendar covers, closure days and Sundays included. `r` is 0..1. */
  someDay(r: number): string {
    const first = this.from();
    let span = 0;
    while (addDays(first, span + 1) <= this.calendarEnds && span < 60) span++;
    return addDays(first, Math.floor(r * (span + 1)));
  }

  patients(fits: (p: HarvestedPatient) => boolean = () => true): HarvestedPatient[] {
    return this.snapshot.patients.filter(fits);
  }

  provider(id: string): Record<string, unknown> | undefined {
    return this.snapshot.providers.find((p) => p.id === id);
  }

  async availability(q: Query): Promise<RealAvailability> {
    const from = q.from ?? this.from();
    const key = JSON.stringify([from, q.to ?? this.to(from), q.specialty, q.provider, q.location, q.patient?.patient_id, q.insurer]);
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = this.#clinic
        .availability({
          date_from: from,
          date_to: q.to ?? this.to(from),
          specialty_id: q.specialty,
          provider_id: q.provider,
          location_id: q.location,
          patient_id: q.patient?.patient_id,
          insurer: q.insurer,
        })
        .catch(() => ({ providers: [], appointment_type: null, slots: [], blocked: [] }));
      this.#cache.set(key, pending);
    }
    return pending;
  }

  async slots(q: Query): Promise<RealSlot[]> {
    const { slots } = await this.availability(q);
    return [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time));
  }

  /** The earliest slot the clinic offers, and everything tied with it. */
  async earliest(q: Query, fits: (s: RealSlot) => boolean = () => true): Promise<Found | null> {
    const slots = (await this.slots(q)).filter(fits);
    const first = slots[0];
    if (!first) return null;
    return { slot: first, tied: slots.filter((s) => s.start_time === first.start_time) };
  }

  /**
   * Why the clinic refuses, in its own words — null when it does not refuse, or when
   * the blocked providers disagree. A case is only worth writing when it is one rule.
   */
  async refusal(q: Query): Promise<string | null> {
    const response = await this.availability(q);
    if (response.slots.length > 0 || response.blocked.length === 0) return null;
    const reasons = new Set(response.blocked.map((b) => b.restriction));
    return reasons.size === 1 ? [...reasons][0]! : null;
  }

  /** The first patient the clinic refuses for `reason`, with the query that does it. */
  async findRefused(
    reason: string,
    query: (p: HarvestedPatient) => Query,
    fits: (p: HarvestedPatient) => boolean = () => true,
    limit = 24,
  ): Promise<HarvestedPatient | null> {
    let tried = 0;
    for (const patient of this.snapshot.patients) {
      if (!fits(patient)) continue;
      if (tried++ >= limit) break;
      if ((await this.refusal({ ...query(patient), patient })) === reason) return patient;
    }
    return null;
  }

  /** The first patient who fits and whom the clinic will actually give a slot. */
  async findBookable(
    fits: (p: HarvestedPatient) => boolean,
    query: (p: HarvestedPatient) => Query,
    limit = 24,
  ): Promise<{ patient: HarvestedPatient; found: Found } | null> {
    let tried = 0;
    for (const patient of this.snapshot.patients) {
      if (!fits(patient)) continue;
      if (tried++ >= limit) break;
      const found = await this.earliest({ ...query(patient), patient });
      if (found) return { patient, found };
    }
    return null;
  }
}

// --- writing expectations ---------------------------------------------------

export function anyOf(values: string[]): Matcher {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0]! : { any: unique };
}

export function bookOf(patient: HarvestedPatient, tied: RealSlot[], policy = patient.insurer): ExpectedAction {
  return {
    action: 'BOOK',
    patient_id: patient.patient_id,
    provider_id: anyOf(tied.map((s) => s.provider_id)),
    location_id: anyOf(tied.map((s) => s.location_id)),
    appointment_type_id: anyOf(tied.map((s) => s.appointment_type_id)),
    slot: tied[0]!.start_time,
    policy_id: policy,
  };
}

export function noAction(reason: string): ExpectedAction {
  return { action: 'NO_ACTION', reason };
}

export function escalate(reason: string): ExpectedAction {
  return { action: 'ESCALATE', reason };
}

export function fullName(p: HarvestedPatient): string {
  return `${p.given_name} ${p.first_surname} ${p.second_surname}`;
}

export function e164(p: HarvestedPatient): string {
  return `+34${p.phone}`;
}

export function spellOut(value: string): string {
  return value.split('').join(' ');
}

/** "Thursday the 24th", the way a caller says a date they were given. */
export function spokenDate(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T12:00:00+02:00`);
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' });
}

export function spokenTime(iso: string): string {
  return iso.slice(11, 16);
}
