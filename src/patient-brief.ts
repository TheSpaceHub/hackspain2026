import {
  planByName,
  type Catalogue,
} from './clinic-api.js';
import { fold } from './fuzzy.js';
import type { CallState } from './call-state.js';
import type { Patient } from './schema.js';

export interface PatientBrief {
  age_years?: number;
  visit_kind: 'first_visit' | 'review' | 'unknown';
  plan?: { id: string; name: string };
  unknown_plan?: string;
  uncovered_specialties: { id: string; name: string }[];
  uncovered_locations: { id: string; name: string }[];
  refusing_providers: { id: string; name: string }[];
  age_ineligible_specialties: { id: string; name: string }[];
  referrals_held: string[];
  referral_missing: { id: string; name: string }[];
}

function ageInMonths(dateOfBirth: string, now: Date): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = new Date(now);
  let months = (at.getUTCFullYear() - year) * 12 + (at.getUTCMonth() + 1 - month);
  if (at.getUTCDate() < day) months--;
  return months >= 0 ? months : undefined;
}

function namesMatch(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

export function buildPatientBrief(patient: Patient, catalogue: Catalogue, now: Date): PatientBrief {
  const ageMonths = patient.date_of_birth ? ageInMonths(patient.date_of_birth, now) : undefined;
  const plan = patient.insurer
    ? planByName(catalogue, patient.insurer)
    : undefined;
  const planOnRecord = patient.insurer?.trim() || undefined;
  const planData = plan
    ? catalogue.plans.find((candidate) => candidate.id === plan.id)
    : undefined;
  const referrals = patient.referrals ?? [];
  const referralSet = new Set(referrals.map(fold));

  return {
    ...(ageMonths === undefined ? {} : { age_years: Math.floor(ageMonths / 12) }),
    visit_kind: patient.has_visited_before === true
      ? 'review'
      : patient.has_visited_before === false
        ? 'first_visit'
        : 'unknown',
    ...(plan && planData
      ? { plan: { id: plan.id, name: plan.name } }
      : planOnRecord
        ? { unknown_plan: planOnRecord }
        : {}),
    uncovered_specialties: planData
      ? catalogue.specialties.filter((specialty) =>
        planData.uncovered_specialty_names.some((name) => namesMatch(name, specialty.name)),
      ).map(({ id, name }) => ({ id, name }))
      : [],
    uncovered_locations: planData
      ? catalogue.locations.filter((location) =>
        planData.uncovered_location_names.some((name) => namesMatch(name, location.name)),
      ).map(({ id, name }) => ({ id, name }))
      : [],
    refusing_providers: planData
      ? catalogue.providers.filter((provider) =>
        provider.refused_insurers.some((insurer) => insurer.id === planData.id),
      ).map(({ id, name }) => ({ id, name }))
      : [],
    age_ineligible_specialties: ageMonths === undefined
      ? []
      : catalogue.specialties.filter((specialty) =>
        (specialty.min_age_months !== null && ageMonths < specialty.min_age_months) ||
        (specialty.max_age_months !== null && ageMonths > specialty.max_age_months),
      ).map(({ id, name }) => ({ id, name })),
    referrals_held: referrals,
    referral_missing: catalogue.specialties.filter((specialty) =>
      specialty.referral_required && !referralSet.has(fold(specialty.id)),
    ).map(({ id, name }) => ({ id, name })),
  };
}

function names(items: { name: string }[]): string {
  return items.map((item) => item.name).join(', ');
}

export function describeBrief(brief: PatientBrief): string {
  const lines: string[] = [];
  if (brief.unknown_plan) {
    lines.push(`Plan on record '${brief.unknown_plan}' is not one the clinic bills.`);
  } else if (brief.plan) {
    const facts: string[] = [];
    if (brief.uncovered_specialties.length > 0) {
      facts.push(`does not cover ${names(brief.uncovered_specialties)}`);
    }
    if (brief.uncovered_locations.length > 0) {
      facts.push(`does not cover ${names(brief.uncovered_locations)}`);
    }
    if (brief.refusing_providers.length > 0) {
      facts.push(`${names(brief.refusing_providers)} does not take it`);
    }
    if (facts.length > 0) lines.push(`Plan ${brief.plan.name}: ${facts.join('; ')}.`);
  }
  if (brief.plan && brief.referrals_held.length > 0) {
    lines.push(`Referral held for ${brief.referrals_held.join(', ')}.`);
  }
  if (brief.plan && brief.referral_missing.length > 0) {
    lines.push(`Referral needed for ${names(brief.referral_missing)}.`);
  }
  if (brief.visit_kind !== 'unknown') {
    lines.push(
      brief.visit_kind === 'review'
        ? 'Existing patient → review-type appointments.'
        : 'New patient → first-visit appointments.',
    );
  }
  if (brief.age_years !== undefined && brief.age_ineligible_specialties.length > 0) {
    lines.push(`Age ${brief.age_years}: ${names(brief.age_ineligible_specialties)} not applicable.`);
  }
  return lines.slice(0, 4).join(' ');
}

export function attachBrief(state: CallState, catalogue: Catalogue | null | undefined, now: Date): void {
  if (!state.matched || !catalogue) {
    delete state.brief;
    return;
  }
  state.brief = buildPatientBrief(state.matched, catalogue, now);
}
