/**
 * The scratchpad: everything one call has established, in memory, per socket.
 *
 * The transcript is the record of what was said; this is the record of what was
 * *understood*, normalized on the way in. The decider is seeded with it at close, so a
 * value that reached the scratchpad survives a caller who contradicts themselves, a
 * three-minute cut-off, and a transcript the model would otherwise have to re-read.
 */

import {
  normalizeDate,
  normalizeEmail,
  normalizeName,
  normalizeNationalId,
  normalizePhone,
  type Normalized,
} from './normalize.js';
import { distance, fold as fuzzyFold, only, tolerance } from './fuzzy.js';
import { describeBrief } from './patient-brief.js';
import { clog } from './log.js';
import type { PatientBrief } from './patient-brief.js';
import type { Patient } from './schema.js';

/** Everything the caller can tell us about the patient, before the directory confirms it. */
export interface PatientDraft {
  given_name?: string;
  first_surname?: string;
  second_surname?: string;
  national_id?: string;
  date_of_birth?: string;
  phone?: string;
  /** Registration only; the directory does not hold one. */
  email?: string;
  insurer?: string;
}

export type PatientField = keyof PatientDraft;

export type CallRequest = {
  intent?: 'book' | 'reschedule' | 'cancel' | 'register' | 'question';
  specialty_id?: string;
  /** As said on the call. Resolving it to an id is the catalogue's job, not the model's. */
  provider_name?: string;
  provider_id?: string;
  location_id?: string;
  /** The caller's own words, resolved by `resolveWhen`. */
  when_phrase?: string;
  part_of_day?: 'morning' | 'afternoon';
  language?: string;
  /** Every plan the caller has named, first on the record and any second asked for. */
  insurers: string[];
  /** The symptom in the caller's words, when they describe one instead of a specialty. */
  complaint?: string;
  appointment_id?: string;
  blocked_by?: string;
};

/** A slot we read out loud. The one the caller accepted is the one we submit, exactly. */
export interface QuotedSlot {
  provider_id: string;
  provider_name?: string;
  location_id: string;
  appointment_type_id: string;
  /** ISO 8601 with offset, straight from /availability — never re-derived from speech. */
  start_time: string;
  payable_with?: string[];
}

export interface CallState {
  readonly call_id: string;
  /**
   * The line the call arrived on, normalized — a free directory query. Deliberately not
   * the draft's phone: a daughter ringing about her father gives us her number, not his.
   */
  from_number?: string;
  patient: PatientDraft;
  /** The directory row we settled on. `patient_id` comes from here and nowhere else. */
  matched: Patient | null;
  brief?: PatientBrief;
  matched_by?: 'phone' | 'lookup';
  /** Problem 9: booking for the caller instead of the patient is the failure mode. */
  caller_is_patient: boolean;
  caller?: { name?: string; relationship?: string };
  request: CallRequest;
  quoted: QuotedSlot[];
  turns_seen: number;
  quoted_at?: number;
  accepted: QuotedSlot | null;
  phone_match_rejected?: string;
  /** Every write, in order, including the ones that were later retracted. */
  journal: { at: string; field: string; value: string | null; note?: string }[];
}

export function createCallState(callId: string, fromNumber?: string): CallState {
  const state: CallState = {
    call_id: callId,
    patient: {},
    matched: null,
    caller_is_patient: true,
    request: { insurers: [] },
    quoted: [],
    turns_seen: 0,
    accepted: null,
    journal: [],
  };
  if (fromNumber) {
    const phone = normalizePhone(fromNumber);
    if (!phone.problem) {
      state.from_number = phone.value;
      record(state, 'from_number', phone.value, 'caller id');
    }
  }
  return state;
}

const NORMALIZERS: Record<PatientField, (spoken: string) => Normalized> = {
  given_name: normalizeName,
  first_surname: normalizeName,
  second_surname: normalizeName,
  national_id: normalizeNationalId,
  date_of_birth: normalizeDate,
  phone: normalizePhone,
  email: normalizeEmail,
  insurer: (spoken) => ({ value: planId(spoken) }),
};

export interface RecordResult {
  /** What was stored, normalized. Read *this* back to the caller, not what was heard. */
  value: string;
  stored: boolean;
  /** Set when the value is suspect — the agent should ask again rather than move on. */
  problem?: string;
}

/**
 * One field of the patient draft. A value that fails its own check — a DNI whose letter
 * does not match its digits — is stored anyway and flagged: the caller can only correct
 * what we admit we heard, and a flagged value still beats an empty field at close.
 */
export function recordPatientField(
  state: CallState,
  field: PatientField,
  spoken: string,
): RecordResult {
  const { value, problem } = NORMALIZERS[field](spoken);
  if (field === 'insurer' && !value) {
    clog.warn(`[state] dropped insurer "${spoken}": not a plan the clinic bills`);
    return { value: '', stored: false, problem: 'not a plan the clinic bills' };
  }
  record(state, field, value, problem);
  state.patient[field] = value;
  return { value, stored: true, problem };
}

/** Merge; later wins. Problem 13 is scored on the caller's *final* stated request. */
export function recordRequest(state: CallState, patch: Partial<CallRequest>): CallRequest {
  const { insurers, ...rest } = patch;
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    (state.request as Record<string, unknown>)[key] = value;
    record(state, `request.${key}`, String(value));
  }
  for (const insurer of insurers ?? []) {
    const id = planId(insurer);
    if (id && !state.request.insurers.includes(id)) {
      state.request.insurers.push(id);
      record(state, 'request.insurer', id);
    } else if (!id) {
      clog.warn(`[state] dropped insurer "${insurer}": not a plan the clinic bills`);
    }
  }
  return state.request;
}

export function recordThirdParty(
  state: CallState,
  callerIsPatient: boolean,
  caller?: { name?: string; relationship?: string },
): void {
  state.caller_is_patient = callerIsPatient;
  if (caller) state.caller = { ...state.caller, ...caller };
  record(state, 'caller_is_patient', String(callerIsPatient), caller?.relationship);
}

/** The directory row. Everything downstream — patient_id, appointment type — reads this. */
export function recordMatch(
  state: CallState,
  patient: Patient | null,
  note?: string,
  by?: 'phone' | 'lookup',
): void {
  state.matched = patient;
  if (patient) state.matched_by = by;
  else delete state.matched_by;
  record(state, 'matched', patient?.patient_id ?? null, note);
}

export function contradictsMatch(state: CallState, given?: string, surname?: string): boolean {
  if (!state.matched) return false;
  const pieces: { spoken: string | undefined; record: string | null | undefined; prefix?: boolean }[] = [
    { spoken: given, record: state.matched.given_name, prefix: true },
    { spoken: surname, record: state.matched.first_surname },
  ];
  const present = pieces.filter((piece) => piece.spoken?.trim());
  if (present.length === 0) return false;
  return !present.some(({ spoken, record, prefix }) => {
    return namePartMatches(spoken!, record, prefix);
  });
}

function namePartMatches(spoken: string, record: string | null | undefined, prefix = false): boolean {
  if (!record) return false;
  const needle = fuzzyFold(spoken);
  const haystack = fuzzyFold(record);
  if (!needle) return false;
  if (needle === haystack) return true;
  if (prefix && (haystack.startsWith(needle) || needle.startsWith(haystack))) return true;
  return distance(needle, haystack) <= tolerance(needle);
}

/** Slots we actually said out loud, so the submitted `slot` is the quoted string exactly. */
export function recordQuote(state: CallState, slots: QuotedSlot[]): void {
  state.quoted = slots;
  state.quoted_at = state.turns_seen;
  for (const slot of slots) record(state, 'quoted', `${slot.start_time} ${slot.provider_id}`);
}

const ORDINALS: Record<string, number> = {
  first: 0,
  earliest: 0,
  soonest: 0,
  second: 1,
  third: 2,
  last: -1,
  latest: -1,
};

/** Hour and minute of a quoted slot in Madrid, the clock the caller hears. */
function clockFace(iso: string): { hour: number; minute: number } | undefined {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? { hour, minute } : undefined;
}

export function saidTimes(turn: string): { hour: number; minute: number }[] {
  const times: { hour: number; minute: number }[] = [];
  for (const m of turn.matchAll(/\b(\d{1,2})\s*[:.\s]\s*(\d{2})\b/g)) {
    times.push({ hour: Number(m[1]), minute: Number(m[2]) });
  }
  return times;
}

export function sameClock(
  slot: QuotedSlot,
  said: { hour: number; minute: number },
): boolean {
  const face = clockFace(slot.start_time);
  if (!face || face.minute !== said.minute) return false;
  // "11:45" and "quarter to twelve in the morning" reach us as the 12-hour face.
  return face.hour === said.hour || face.hour === said.hour + 12;
}

/**
 * The model is meant to call accept_slot the moment the caller picks a time, and when it
 * forgets, a call with a real slot on the table submits `no_action` for want of the ids.
 * The caller's own words are enough to settle it without the model: a time that matches
 * exactly one quoted slot, or an ordinal over the list we read out in order. Anything
 * ambiguous is left alone — a wrong appointment is worse than none.
 */
export function acceptFromTranscript(
  state: CallState,
  turns: { role: string; text: string }[],
): QuotedSlot | null {
  if (state.accepted || state.quoted.length === 0) return null;
  const spoken = turns
    .map((turn, index) => ({ ...turn, index }))
    .filter((turn) => turn.role === 'user' && turn.index >= (state.quoted_at ?? 0));

  for (let i = spoken.length - 1; i >= 0; i--) {
    const text = spoken[i]!.text.toLowerCase();

    const byClock = saidTimes(text).flatMap((said) =>
      state.quoted.filter((slot) => sameClock(slot, said)),
    );
    if (byClock.length === 1) {
      recordAccepted(state, byClock[0]!, 'inferred from the caller');
      return byClock[0]!;
    }
    if (byClock.length > 1) return null;

    // Availability questions such as "what is the soonest" are requests, not choices.
    const asksForOptions = /\b(?:what|which|when|do you have|is there)\b/.test(text) &&
      Object.keys(ORDINALS).some((word) => new RegExp(`\\b${word}\\b`).test(text));
    const ordinals = asksForOptions
      ? []
      : Object.keys(ORDINALS).filter((word) => new RegExp(`\\b${word}\\b`).test(text));
    if (ordinals.length === 1) {
      const at = ORDINALS[ordinals[0]!]!;
      const slot = at < 0 ? state.quoted[state.quoted.length - 1] : state.quoted[at];
      if (slot) {
        recordAccepted(state, slot, 'inferred from the caller');
        return slot;
      }
    }
  }
  return null;
}

export function recordAccepted(state: CallState, slot: QuotedSlot, note?: string): void {
  state.accepted = slot;
  record(state, 'accepted', `${slot.start_time} ${slot.provider_id}`, note);
}

/** An id stated and then contradicted. Explicit, so the journal shows both. */
export function retract(state: CallState, field: PatientField | keyof CallRequest): void {
  if (field in state.patient) delete state.patient[field as PatientField];
  else if (field in state.request) delete (state.request as Record<string, unknown>)[field];
  record(state, String(field), null, 'retracted');
}

/** What the model re-grounds on mid-call, and what the decider is seeded with at close. */
export function readCallState(state: CallState): string {
  const lines: string[] = [];
  const patient = state.matched
    ? `on file: ${state.matched.patient_id} ${[state.matched.given_name, state.matched.first_surname, state.matched.second_surname].filter(Boolean).join(' ')}` +
      ` · visited before: ${String(state.matched.has_visited_before ?? 'unknown')}` +
      ` · plan on record: ${state.matched.insurer ?? 'unknown'}`
    : 'not identified yet';
  lines.push(
    `Patient: ${patient}` +
      (!state.matched && state.phone_match_rejected ? ' · number on file belongs to someone else' : ''),
  );
  if (state.brief) {
    const described = describeBrief(state.brief);
    if (described) lines.push(`Rules for this patient: ${described}`);
  }

  const draft = Object.entries(state.patient)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  if (draft) lines.push(`Heard: ${draft}`);
  if (!state.caller_is_patient) {
    lines.push(`Caller is NOT the patient: ${state.caller?.name ?? 'unnamed'} (${state.caller?.relationship ?? 'relationship unstated'})`);
  }

  const request = Object.entries(state.request)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
  lines.push(`Request: ${request || '(nothing yet)'}`);
  if (state.request.blocked_by) lines.push(`Rule that stopped the diary: ${state.request.blocked_by}`);

  // The plan the booking is billed against: the right slot on the wrong plan fails.
  const policy = choosePolicy(state);
  const payable = state.accepted?.payable_with ?? [];
  if (policy || payable.length > 0) {
    lines.push(
      `Billing: policy_id=${policy ?? '(none established)'}` +
        (payable.length > 0 ? ` · this slot bills against ${payable.join(', ')}` : '') +
        ` · plans heard: ${[...new Set(knownPlans(state))].join(', ') || 'none'}`,
    );
  }

  if (state.accepted) {
    const a = state.accepted;
    lines.push(
      `Accepted slot: slot=${a.start_time} provider_id=${a.provider_id} location_id=${a.location_id}` +
        ` appointment_type_id=${a.appointment_type_id}` +
        (a.payable_with?.length ? ` payable_with=${a.payable_with.join(',')}` : ''),
    );
  } else if (state.quoted.length > 0) {
    lines.push('Quoted, none accepted:');
    for (const s of state.quoted) {
      lines.push(
        `  slot=${s.start_time} provider_id=${s.provider_id} location_id=${s.location_id}` +
          ` appointment_type_id=${s.appointment_type_id}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * The plans the clinic bills, set once at boot. Callers say "Nueva Mutua Sanitaria"
 * and the diary bills `nueva_mutua`, and `policy_id` is scored on the id — so the
 * translation has to happen where the plan is written down, not where it is submitted.
 */
let PLANS: { id: string; name: string }[] = [];

export function setPlanVocabulary(plans: { id: string; name: string }[]): void {
  PLANS = plans;
}

const fold = (text: string): string =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\s]+/g, ' ').trim();

const planTolerance = (needle: string): number => Math.max(2, Math.floor(needle.length / 4));

/** The clinic's id for a spoken plan, or the spoken plan tidied up when it knows none. */
export function planId(spoken: string): string {
  const match = only(
    PLANS.map((plan) => ({ item: plan, aliases: [plan.id, plan.name] })),
    spoken,
    planTolerance,
  );
  return match?.id ?? '';
}

/** Every plan this call knows of, the ones the caller named first. */
export function knownPlans(state: CallState): string[] {
  return [state.matched?.insurer, ...state.request.insurers, state.patient.insurer].filter(
    (plan): plan is string => typeof plan === 'string' && plan.trim() !== '',
  );
}

/**
 * Which plan a booking is billed against (problem 17).
 *
 * Not a judgement: /availability prices the slot against every plan we passed it and
 * returns `payable_with`, so the answer is the intersection of that with the plans this
 * call knows of. The record plan is primary; a plan named on the call is a second policy
 * and wins only when it is the one the diary says the accepted slot can be billed against.
 */
export function choosePolicy(state: CallState): string | undefined {
  const named = knownPlans(state);
  const payable = state.accepted?.payable_with ?? [];
  if (payable.length > 0) return named.find((plan) => payable.includes(plan)) ?? payable[0];
  return named[0];
}

/** The fields a registration needs, so the agent knows what is still missing. */
export const REGISTRATION_FIELDS: PatientField[] = [
  'given_name', 'first_surname', 'second_surname', 'national_id',
  'date_of_birth', 'phone', 'email', 'insurer',
];

export function missingForRegistration(state: CallState): PatientField[] {
  return REGISTRATION_FIELDS.filter((f) => !state.patient[f]);
}

function record(state: CallState, field: string, value: string | null, note?: string): void {
  state.journal.push({ at: new Date().toISOString(), field, value, note });
}
