/**
 * GET /availability. What a patient may book and when — and, just as important,
 * *why not*: every candidate provider a standing rule stops comes back in `blocked`
 * naming that rule, whether or not there are slots. Empty slots with empty blocked
 * means the diaries are simply full, which is a different answer.
 *
 * Rules, in the order they are checked:
 *   patient-wide   not_eligible_age · referral_required
 *   per provider   type_not_offered · provider_on_leave · location_hours
 *   per plan       specialty_not_covered · location_not_covered · provider_not_in_network
 *                  · insurer_referral_required · allowance_exhausted
 * A provider is blocked by a plan rule only when no plan in play can pay; the reason
 * given is the first plan's.
 */
import {
  ALLOWANCE_CAPS,
  type AppointmentType,
  INSURER_REFERRALS,
  type Insurer,
  type Provider,
} from '../world/catalogue.js';
import { onLeave, workingCells } from '../world/diary.js';
import type { Patient } from '../world/people.js';
import type { World } from '../world/world.js';
import { ageInMonths, daysBetween, eachDay, madridIso, toInstant } from './time.js';

export interface AvailabilityQuery {
  date_from: string;
  date_to: string;
  provider_id?: string;
  specialty_id?: string;
  location_id?: string;
  patient_id?: string;
  insurer: Insurer[];
}

export interface ProviderOut {
  id: string;
  name: string;
  specialty_id: string;
  languages: string[];
  accepted_insurers: string[];
  locations: string[];
  on_leave_until: string | null;
}
export interface SlotOut {
  provider_id: string;
  provider_name: string;
  specialty_id: string;
  location_id: string;
  appointment_type_id: string;
  start_time: string;
  duration_minutes: number;
  payable_with: string[];
}
export interface AvailabilityResponse {
  providers: ProviderOut[];
  appointment_type: Omit<AppointmentType, 'provider_names' | 'specialty_id' | 'specialty_name'>;
  slots: SlotOut[];
  blocked: { provider_id: string; restriction: string }[];
}

/** A 422 the way the real API words its business rules: `detail` as a plain string. */
export class AvailabilityError extends Error {}

const CELL = 15;

function providerOut(p: Provider): ProviderOut {
  return {
    id: p.id,
    name: p.name,
    specialty_id: p.specialty_id,
    languages: p.languages,
    accepted_insurers: p.accepted_insurers.map((i) => i.id).sort(),
    locations: p.schedules.map((s) => s.location_id),
    on_leave_until: p.leave?.end ?? null,
  };
}

/** The first plan rule that stops `plan` paying for this provider at this site, or null. */
function planRule(world: World, plan: Insurer, provider: Provider, location: string, patient: Patient | undefined): string | null {
  const cat = world.catalogue;
  const specialty = provider.specialty_id;
  if (!cat.planCoversSpecialty(plan, specialty)) return 'specialty_not_covered';
  if (!cat.planCoversLocation(plan, location)) return 'location_not_covered';
  if (!cat.providerTakes(provider, plan)) return 'provider_not_in_network';
  if (patient) {
    if (INSURER_REFERRALS[plan]?.includes(specialty) && !patient.referrals.includes(specialty)) {
      return 'insurer_referral_required';
    }
    const cap = ALLOWANCE_CAPS[plan]?.[specialty];
    if (cap !== undefined && (patient.allowance_spent[specialty] ?? 0) >= cap) return 'allowance_exhausted';
  }
  return null;
}

export function availability(world: World, q: AvailabilityQuery, now: number): AvailabilityResponse {
  const cat = world.catalogue;
  const { starts, ends, closure_days, max_span_days } = cat.calendar;

  if (!q.provider_id && !q.specialty_id) throw new AvailabilityError('availability needs provider_id or specialty_id');
  if (q.date_from > q.date_to) throw new AvailabilityError('date_from is after date_to');
  if (q.date_from < starts || q.date_to > ends) {
    throw new AvailabilityError(`the calendar runs ${starts} to ${ends}; ${q.date_from}..${q.date_to} is outside it`);
  }
  if (daysBetween(q.date_from, q.date_to) > max_span_days) {
    throw new AvailabilityError(`a window may span at most ${max_span_days} days`);
  }

  const named = q.provider_id ? cat.providers.get(q.provider_id) : undefined;
  if (q.provider_id && !named) throw new AvailabilityError(`unknown provider_id '${q.provider_id}'`);
  if (q.specialty_id && !cat.specialties.has(q.specialty_id)) throw new AvailabilityError(`unknown specialty_id '${q.specialty_id}'`);
  if (named && q.specialty_id && named.specialty_id !== q.specialty_id) {
    throw new AvailabilityError(`provider '${named.id}' is not in specialty '${q.specialty_id}'`);
  }
  if (q.location_id && !cat.locations.has(q.location_id)) throw new AvailabilityError(`unknown location_id '${q.location_id}'`);
  const patient = q.patient_id ? world.patient(q.patient_id) : undefined;
  if (q.patient_id && !patient) throw new AvailabilityError(`unknown patient_id '${q.patient_id}'`);

  const specialtyId = named?.specialty_id ?? q.specialty_id!;
  const specialty = cat.specialties.get(specialtyId)!;
  const candidates = named ? [named] : cat.providersOf(specialtyId);
  // The type follows the record. With no patient named, quote the first-visit type.
  const type = cat.typeFor(specialtyId, patient?.has_visited_before ?? false);
  const { provider_names: _n, specialty_id: _s, specialty_name: _sn, ...typeOut } = type;

  // Which plans are in play: the ones asked about, else the one on the record, else any.
  const plans: Insurer[] | null = q.insurer.length > 0 ? q.insurer : patient ? [patient.insurer] : null;

  const blocked: AvailabilityResponse['blocked'] = [];
  const slots: SlotOut[] = [];

  // Patient-wide rules stop every provider of the specialty at once.
  let patientRule: string | null = null;
  if (patient) {
    const age = ageInMonths(patient.date_of_birth, q.date_from);
    if (age < specialty.min_age_months || (specialty.max_age_months !== null && age > specialty.max_age_months)) {
      patientRule = 'not_eligible_age';
    } else if (specialty.referral_required && !patient.referrals.includes(specialtyId)) {
      patientRule = 'referral_required';
    }
  }

  const days = [...eachDay(q.date_from, q.date_to)].filter((d) => !closure_days.includes(d));

  for (const provider of candidates) {
    if (patientRule) {
      blocked.push({ provider_id: provider.id, restriction: patientRule });
      continue;
    }
    if (!cat.typesOf(provider).has(type.id)) {
      blocked.push({ provider_id: provider.id, restriction: 'type_not_offered' });
      continue;
    }
    const workDays = days.filter((d) => !onLeave(provider, d));
    if (workDays.length === 0) {
      blocked.push({ provider_id: provider.id, restriction: 'provider_on_leave' });
      continue;
    }
    const sites = provider.schedules.map((s) => s.location_id).filter((l) => !q.location_id || l === q.location_id);
    if (sites.length === 0) {
      blocked.push({ provider_id: provider.id, restriction: 'location_hours' });
      continue;
    }

    // Who can pay at each site; a site nobody in play can pay at yields no slots.
    const payersAt = new Map<string, string[]>();
    let firstRefusal: string | null = null;
    for (const site of sites) {
      const pool = plans ?? [...cat.plans.keys()].map((id) => id as Insurer);
      const payers = pool.filter((plan) => {
        const rule = planRule(world, plan, provider, site, patient);
        if (rule && plans && plan === plans[0]) firstRefusal ??= rule;
        return !rule;
      });
      payersAt.set(site, payers.sort());
    }
    if ([...payersAt.values()].every((p) => p.length === 0)) {
      blocked.push({ provider_id: provider.id, restriction: firstRefusal ?? 'specialty_not_covered' });
      continue;
    }

    const need = Math.ceil(type.duration_minutes / CELL);
    let sat = false;
    for (const date of workDays) {
      const cells = workingCells(cat, provider, date).filter((c) => sites.includes(c.location));
      if (cells.length) sat = true;
      for (const cell of cells) {
        const payers = payersAt.get(cell.location) ?? [];
        if (payers.length === 0) continue;
        const contiguous = Array.from({ length: need }, (_, i) => cell.minute + i * CELL).every((m) =>
          cells.some((c) => c.location === cell.location && c.minute === m),
        );
        if (!contiguous || !world.diary.isFree(provider.id, date, cell.minute, need)) continue;
        const start = madridIso(date, cell.minute);
        // Listed later today, never earlier; the calendar is what it is.
        if (toInstant(start) <= now) continue;
        slots.push({
          provider_id: provider.id,
          provider_name: provider.name,
          specialty_id: provider.specialty_id,
          location_id: cell.location,
          appointment_type_id: type.id,
          start_time: start,
          duration_minutes: type.duration_minutes,
          payable_with: payers,
        });
      }
    }
    // Sitting at the asked-for site but never on the asked-for days.
    if (!sat && q.location_id) blocked.push({ provider_id: provider.id, restriction: 'location_hours' });
  }

  slots.sort((a, b) => toInstant(a.start_time) - toInstant(b.start_time) || a.provider_id.localeCompare(b.provider_id));
  return { providers: candidates.map(providerOut), appointment_type: typeOut, slots, blocked };
}
