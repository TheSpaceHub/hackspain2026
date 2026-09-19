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
import { madridDate, resolveWhen } from './when.js';

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
  for_patient_id?: string;
  /** ISO 8601 with offset, straight from /availability — never re-derived from speech. */
  start_time: string;
  payable_with?: string[];
}

export interface UpcomingAppointment {
  appointment_id: string;
  start_time: string;
  location_id?: string;
  provider_id?: string;
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
  upcoming: UpcomingAppointment[];
  appointment_ids: string[];
  appointment_picked_by?: 'only_one' | 'caller';
  quoted: QuotedSlot[];
  declined: string[];
  quoted_spoken: boolean;
  turns_seen: number;
  quoted_at?: number;
  /** Final caller utterances so far, and how many there were when the quote was read. */
  caller_turns: number;
  quoted_after_caller_turns?: number;
  last_caller_text?: string;
  accepted: QuotedSlot | null;
  phone_match_rejected?: string;
  invented_offer?: string;
  invented_provider?: string;
  /** Doctor names (folded) the caller has already been asked to spell. */
  spelling_asked: string[];
  rejected: Partial<Record<PatientField, { spoken: string; problem: string }>>;
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
    upcoming: [],
    appointment_ids: [],
    quoted: [],
    declined: [],
    quoted_spoken: false,
    turns_seen: 0,
    caller_turns: 0,
    accepted: null,
    spelling_asked: [],
    rejected: {},
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
 * does not match its digits — is dropped before it can reach registration or lookup.
 */
export function recordPatientField(
  state: CallState,
  field: PatientField,
  spoken: string,
): RecordResult {
  const { value, problem } = NORMALIZERS[field](spoken);
  if (field === 'insurer' && !value) {
    state.rejected[field] = { spoken, problem: 'not a plan the clinic bills' };
    clog.warn(`[state] dropped insurer "${spoken}": not a plan the clinic bills`);
    return { value: '', stored: false, problem: 'not a plan the clinic bills' };
  }
  if (field === 'national_id' && problem) {
    state.rejected[field] = { spoken, problem };
    clog.warn(`[state] dropped national id "${spoken}": ${problem}`);
    return { value: '', stored: false, problem };
  }
  delete state.rejected[field];
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
  state.quoted_spoken = false;
  state.quoted_at = state.turns_seen;
  state.quoted_after_caller_turns = state.caller_turns;
  for (const slot of slots) record(state, 'quoted', `${slot.start_time} ${slot.provider_id}`);
}

/** Nobody has answered the offer yet: the caller has not spoken since it was read. */
export function callerSilentSinceQuote(state: CallState): boolean {
  return (
    state.quoted.length > 0 &&
    state.quoted_after_caller_turns !== undefined &&
    state.caller_turns === state.quoted_after_caller_turns
  );
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
  for (const m of turn.matchAll(/\b(\d{1,2})(?:(?:\s*[:.]\s*|\s+)(\d{2})\s*(am|pm)?|\s*(am|pm))\b/gi)) {
    let hour = Number(m[1]);
    const minute = Number(m[2] ?? 0);
    const meridiem = (m[3] ?? m[4])?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    times.push({ hour, minute });
  }
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const minutes: Record<string, number> = {
    oh: 0, zero: 0, five: 5, ten: 10, fifteen: 15, twenty: 20,
    'twenty five': 25, thirty: 30, 'thirty five': 35,
    forty: 40, 'forty five': 45, fifty: 50, 'fifty five': 55,
  };
  const wordPattern = Object.keys(words).join('|');
  const minutePattern = Object.keys(minutes)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(' ', '[- ]'))
    .join('|');
  const re = new RegExp(
    `\\b(${wordPattern})(?:\\s+(${minutePattern})(?:\\s+(am|pm))?|\\s+(am|pm))\\b`,
    'gi',
  );
  for (const m of turn.matchAll(re)) {
    const hour = words[m[1]!.toLowerCase()];
    if (hour === undefined) continue;
    const minuteWord = m[2]?.toLowerCase().replace(/-/g, ' ');
    const minute = minuteWord ? minutes[minuteWord] : 0;
    if (minute === undefined) continue;
    const meridiem = m[3]?.toLowerCase();
    const adjustedHour = meridiem === 'pm' && hour < 12 ? hour + 12 : meridiem === 'am' && hour === 12 ? 0 : hour;
    times.push({ hour: adjustedHour, minute });
  }
  return times;
}

const ACCEPTANCE_WORDS = [
  'yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'fine', 'perfect', 'great', 'good',
  'please', 'book it', 'take it', 'go ahead', 'that one', 'that works', 'suits', 'confirm',
];
const HEDGE_WORDS = [
  'but', 'instead', 'rather', 'other', 'different', 'another', 'no', 'not', "can't",
  'cannot', 'change', 'actually', 'what about', 'could i', 'is there',
];
/** Hedges that, in a question after a clear yes, ask about the booking rather than reopen it. */
const SOFT_HEDGES = ['change', 'could i', 'can i', 'is there'];

/** Classify the caller's last turn without treating surprise or small talk as consent. */
export function callerAccepted(text: string): 'yes' | 'no' | 'unclear' {
  const normalized = text.toLowerCase().replace(/[’]/g, "'");
  // "Yes, that's fine. Could I change it later if I had to?" is a yes with a question
  // after it; "yes, but could I have it at Norte?" is a counter-offer. The hedge only
  // counts against a yes when it shares a sentence with it, or is not a question.
  let accepted = false;
  for (const raw of normalized.split(/(?<=[.!?])\s+/)) {
    const sentence = raw.trim();
    if (sentence === '') continue;
    const test = (token: string): boolean => {
      const pattern = token.includes(' ')
        ? new RegExp(`\\b${token.replace(/ /g, '\\s+')}\\b`, 'i')
        : new RegExp(`\\b${token.replace(/[?]/g, '\\?')}\\b`, 'i');
      return pattern.test(sentence);
    };
    if (HEDGE_WORDS.some(test)) {
      const question = /\?$/.test(sentence) || /^(?:and |um |uh |so )*(?:if |could i|can i|is it|would it|will i|do i)/.test(sentence);
      const counterOffer = HEDGE_WORDS.filter((word) => !SOFT_HEDGES.includes(word)).some(test);
      if (accepted && question && !counterOffer) continue;
      return 'no';
    }
    if (ACCEPTANCE_WORDS.some(test)) accepted = true;
  }
  if (accepted) return 'yes';
  return /\b(?:take|choose|pick)\s+(?:the\s+)?(?:first|second|third|last|latest)\s+one\b/.test(normalized)
    ? 'yes'
    : 'unclear';
}

export function sameClock(
  slot: Pick<QuotedSlot, 'start_time'>,
  said: { hour: number; minute: number },
): boolean {
  const face = clockFace(slot.start_time);
  if (!face || face.minute !== said.minute) return false;
  // "11:45" and "quarter to twelve in the morning" reach us as the 12-hour face.
  return face.hour === said.hour ||
    face.hour === said.hour + 12 ||
    face.hour + 12 === said.hour;
}

export function appointmentKey(appointment: Pick<UpcomingAppointment, 'start_time' | 'provider_id'>): string {
  return `${appointment.start_time}|${appointment.provider_id ?? ''}`;
}

/**
 * Resolve a caller's words against the appointments already read from the diary.
 * A day or clock is accepted only when it identifies exactly one appointment; an
 * ordinal is the explicit list choice and is resolved before the other clues.
 */
export function appointmentsMatching(
  appointments: UpcomingAppointment[],
  said: string,
  now: Date,
): UpcomingAppointment[] {
  const text = said.toLowerCase();
  if (/\b(?:both|all|the two|los dos|todas?)\b/.test(text)) return [...appointments];
  const ordinal = /\b(?:the\s+)?(first|second|third|last|1|2|3)\b/.exec(text)?.[1];
  if (ordinal) {
    const index = ordinal === 'last' ? appointments.length - 1 : ordinal === 'first' || ordinal === '1' ? 0 : ordinal === 'second' || ordinal === '2' ? 1 : ordinal === 'third' || ordinal === '3' ? 2 : -1;
    return index >= 0 && index < appointments.length ? [appointments[index]!] : [];
  }

  const times = saidTimes(said);
  const window = resolveWhen(said, now);
  let matches = window.earliest
    ? appointments
    : appointments.filter((appointment) => madridDate(new Date(appointment.start_time)) === window.date_from);
  if (times.length > 0) {
    matches = matches.filter((appointment) => times.some((time) => sameClock(appointment, time)));
  }
  return matches;
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
  if (state.accepted || state.quoted.length === 0 || !state.quoted_spoken) return null;
  const spoken = turns
    .map((turn, index) => ({ ...turn, index }))
    .filter((turn) => turn.role === 'user' && turn.index >= (state.quoted_at ?? 0));

  const latest = spoken.at(-1);
  if (!latest) return null;
  {
    const text = latest.text.toLowerCase();
    const accepted = callerAccepted(text);
    if (accepted === 'no') return null;

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
    if (accepted === 'yes' && ordinals.length === 1) {
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

export function releaseAccepted(state: CallState, note?: string): void {
  if (!state.accepted) return;
  record(state, 'accepted', null, note ?? 'released');
  state.accepted = null;
}

/** An id stated and then contradicted. Explicit, so the journal shows both. */
export function retract(state: CallState, field: PatientField | keyof CallRequest): void {
  delete state.rejected[field as PatientField];
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
  const rejected = Object.entries(state.rejected)
    .map(([field, value]) => `${field} "${value.spoken}" — ${value.problem}`)
    .join(' · ');
  if (rejected) lines.push(`Rejected (ask again): ${rejected}`);
  if (!state.caller_is_patient) {
    lines.push(`Caller is NOT the patient: ${state.caller?.name ?? 'unnamed'} (${state.caller?.relationship ?? 'relationship unstated'})`);
  }

  const request = Object.entries(state.request)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
  lines.push(`Request: ${request || '(nothing yet)'}`);
  if (state.upcoming.length > 0) {
    lines.push(
      `Upcoming appointments: ${state.upcoming.map((appointment, index) =>
        `${index + 1}=${appointment.appointment_id} ${appointment.start_time}`).join(' · ')}` +
      (state.appointment_picked_by ? ` · picked_by=${state.appointment_picked_by}` : ''),
    );
  }
  if (state.invented_offer) lines.push(`Invented offer: ${state.invented_offer}`);
  if (state.invented_provider) lines.push(`Invented provider: ${state.invented_provider}`);
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
