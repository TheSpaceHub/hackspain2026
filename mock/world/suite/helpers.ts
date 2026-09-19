/** Shared machinery for the case generators: what the world says, and how a case is written. */
import { availability, type SlotOut } from '../../rules/availability.js';
import { addDays, todayMadrid, weekdayOf } from '../../rules/time.js';
import type { Insurer } from '../catalogue.js';
import type { Patient } from '../people.js';
import type { World } from '../world.js';
import type { Case, ExpectedAction, Matcher, Persona } from './types.js';
import { PROBLEM_BY_ID } from './types.js';

/** Nothing is booked same-day: every case's window opens tomorrow. */
export function tomorrow(): string {
  return addDays(todayMadrid(), 1);
}

/** The calendar's last day, or `days` out, whichever comes first — availability caps the span. */
export function windowEnd(world: World, from: string, days = 13): string {
  const end = addDays(from, days);
  return end > world.catalogue.calendar.ends ? world.catalogue.calendar.ends : end;
}

export interface SlotQuery {
  specialty?: string;
  provider?: string;
  location?: string;
  patient?: Patient;
  insurer?: Insurer[];
  from?: string;
  to?: string;
}

export function slotsFor(world: World, q: SlotQuery): SlotOut[] {
  const from = q.from ?? tomorrow();
  try {
    return availability(
      world,
      {
        date_from: from,
        date_to: q.to ?? windowEnd(world, from),
        specialty_id: q.specialty,
        provider_id: q.provider,
        location_id: q.location,
        patient_id: q.patient?.patient_id,
        insurer: q.insurer ?? [],
      },
      Date.now(),
    ).slots;
  } catch {
    return [];
  }
}

/**
 * The earliest slot, and everything tied with it. Where several providers tie on the
 * same minute any of them is right, so the expectation has to accept all of them.
 */
export function earliest(world: World, q: SlotQuery): { slot: SlotOut; tied: SlotOut[] } | null {
  const slots = slotsFor(world, q);
  const first = slots[0];
  if (!first) return null;
  return { slot: first, tied: slots.filter((s) => s.start_time === first.start_time) };
}

/** The earliest slot the caller's own constraint allows, and everything tied with it. */
export function earliestWhere(
  world: World,
  q: SlotQuery,
  fits: (s: SlotOut) => boolean,
): { slot: SlotOut; tied: SlotOut[] } | null {
  const slots = slotsFor(world, q).filter(fits);
  const first = slots[0];
  if (!first) return null;
  return { slot: first, tied: slots.filter((s) => s.start_time === first.start_time) };
}

/** Minutes after midnight, Madrid, of a slot's start — "morning" is before 14:00. */
export function minuteOf(slot: SlotOut): number {
  const [h, m] = slot.start_time.slice(11, 16).split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function dateOf(slot: SlotOut): string {
  return slot.start_time.slice(0, 10);
}

/**
 * Why the world refuses, in its own words. Null when it does not refuse, or when the
 * candidates disagree about the reason — a case is only worth writing when it is one rule.
 */
export function blockedReason(world: World, q: SlotQuery): string | null {
  const from = q.from ?? tomorrow();
  let response;
  try {
    response = availability(
      world,
      {
        date_from: from,
        date_to: q.to ?? windowEnd(world, from),
        specialty_id: q.specialty,
        provider_id: q.provider,
        location_id: q.location,
        patient_id: q.patient?.patient_id,
        insurer: q.insurer ?? [],
      },
      Date.now(),
    );
  } catch {
    return null;
  }
  if (response.slots.length > 0 || response.blocked.length === 0) return null;
  const reasons = new Set(response.blocked.map((b) => b.restriction));
  return reasons.size === 1 ? [...reasons][0]! : null;
}

/** The first patient the world refuses for `reason` on this query — the case writes itself. */
export function findBlocked(
  world: World,
  reason: string,
  query: (p: Patient) => SlotQuery,
  fits: (p: Patient) => boolean = () => true,
): Patient {
  const found = world.patients.find((p) => fits(p) && blockedReason(world, { ...query(p), patient: p }) === reason);
  if (!found) throw new Error(`no patient in the generated world is blocked by '${reason}'`);
  return found;
}

/** A BOOK expectation over a set of tied slots: the fields that must match, one matcher each. */
export function bookOf(patient: Patient, tied: SlotOut[], policy: Insurer): ExpectedAction {
  const any = (values: string[]): Matcher => {
    const unique = [...new Set(values)];
    return unique.length === 1 ? unique[0]! : { any: unique };
  };
  return {
    action: 'BOOK',
    patient_id: patient.patient_id,
    provider_id: any(tied.map((s) => s.provider_id)),
    location_id: any(tied.map((s) => s.location_id)),
    appointment_type_id: any(tied.map((s) => s.appointment_type_id)),
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

// --- picking people ---------------------------------------------------------

/** The first patient in id order that fits — deterministic, because the world is. */
export function findPatient(world: World, fits: (p: Patient) => boolean): Patient {
  const found = world.patients.find(fits);
  if (!found) throw new Error('no patient in the generated world fits this case');
  return found;
}

/** The first patient who fits *and* whom the world can actually give a slot to. */
export function findPatientWithSlot(
  world: World,
  fits: (p: Patient) => boolean,
  query: (p: Patient) => SlotQuery,
): { patient: Patient; found: { slot: SlotOut; tied: SlotOut[] } } {
  for (const patient of world.patients) {
    if (!fits(patient)) continue;
    const found = earliest(world, { ...query(patient), patient });
    if (found) return { patient, found };
  }
  throw new Error('no patient in the generated world can be given this appointment');
}

export function isAdult(p: Patient, on = todayMadrid()): boolean {
  return Date.parse(on) - Date.parse(p.date_of_birth) > 18 * 365.25 * 86_400_000;
}

export function fullName(p: Patient): string {
  return `${p.given_name} ${p.first_surname} ${p.second_surname}`;
}

/** How a caller reads an id or a phone down the line: one character at a time. */
export function spellOut(value: string): string {
  return value.split('').join(' ');
}

export function e164(p: Patient): string {
  return `+34${p.phone}`;
}

// --- writing a case ---------------------------------------------------------

export interface Draft {
  id: string;
  problem: string;
  title: string;
  summary: string;
  origin?: string;
  persona: Omit<Persona, 'turn_cap'> & { turn_cap?: number };
  script: string[];
  expected: Case['expected'];
  language?: Case['language'];
  from_number?: string | null;
  audio?: Case['audio'];
  protectedValues?: string[];
  burst?: number;
}

/**
 * The caller's whole system prompt. The platform writes one per case; this builds the
 * same shape out of the persona, so a local case and a published one read alike.
 */
export function callerPrompt(persona: Persona, language: Case['language']): string {
  const tongue =
    language === 'es' ? 'You speak Spanish and open the call in Spanish.'
    : language === 'ca' ? 'You speak Catalan and open the call in Catalan.'
    : 'You speak English.';
  const data = Object.entries(persona.data)
    .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
    .join('\n');
  return [
    `You are ${persona.name}, on the phone to the reception of Clínica Arenal.`,
    persona.description,
    tongue,
    '',
    'What you know about yourself:',
    data,
    '',
    'What you want out of this call:',
    ...persona.objectives.map((o, i) => `${i + 1}. ${o}`),
    '',
    'How you talk:',
    '- One short turn at a time, the way people actually speak on the phone. Never narrate.',
    '- Never volunteer an identifier before you are asked for one.',
    '- Answer what you are asked and nothing more. Never invent a fact that is not written above:',
    '  if you are asked something you were not told, say you do not know.',
    '- When everything you came for is settled, or the receptionist has clearly refused,',
    '  say goodbye and nothing else. Say the single word END_CALL on a line of its own after that.',
  ].join('\n');
}

export function makeCase(problemId: string, d: Draft): Case {
  const problem = PROBLEM_BY_ID.get(problemId);
  if (!problem) throw new Error(`unknown problem_id '${problemId}'`);
  const language = d.language ?? 'en';
  const persona: Persona = { turn_cap: 16, ...d.persona };
  return {
    id: d.id,
    problem_id: problemId,
    problem: `${problem.number} · ${problem.title}`,
    title: d.title,
    summary: d.summary,
    origin:
      d.origin ??
      'Hand-written for this problem. The ask is fixed; the record it is graded against is computed ' +
        'from the clinic this mock is serving, so it stays right as the diary moves.',
    language,
    from_number: d.from_number === undefined ? null : d.from_number,
    persona,
    caller_prompt: callerPrompt(persona, language),
    script: d.script,
    audio: d.audio ?? { background: 'silence', signal_to_noise_db: null },
    protected: d.protectedValues ?? [],
    burst: d.burst ?? 1,
    expected: d.expected,
  };
}

/** "thursday" → the first such weekday strictly after today, as the docs define it. */
export function nextWeekday(name: string, from = todayMadrid()): string {
  for (let i = 1; i <= 7; i++) {
    const day = addDays(from, i);
    if (weekdayOf(day) === name) return day;
  }
  return addDays(from, 1);
}
