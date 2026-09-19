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
  /** Problem 9: booking for the caller instead of the patient is the failure mode. */
  caller_is_patient: boolean;
  caller?: { name?: string; relationship?: string };
  request: CallRequest;
  quoted: QuotedSlot[];
  accepted: QuotedSlot | null;
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
  insurer: (spoken) => ({ value: spoken.trim().toLowerCase().replace(/\s+/g, '_') }),
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
    const id = insurer.trim().toLowerCase().replace(/\s+/g, '_');
    if (id && !state.request.insurers.includes(id)) {
      state.request.insurers.push(id);
      record(state, 'request.insurer', id);
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
export function recordMatch(state: CallState, patient: Patient | null): void {
  state.matched = patient;
  record(state, 'matched', patient?.patient_id ?? null);
}

/** Slots we actually said out loud, so the submitted `slot` is the quoted string exactly. */
export function recordQuote(state: CallState, slots: QuotedSlot[]): void {
  state.quoted = slots;
  for (const slot of slots) record(state, 'quoted', `${slot.start_time} ${slot.provider_id}`);
}

export function recordAccepted(state: CallState, slot: QuotedSlot): void {
  state.accepted = slot;
  record(state, 'accepted', `${slot.start_time} ${slot.provider_id}`);
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
  lines.push(`Patient: ${patient}`);

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

  if (state.accepted) {
    const a = state.accepted;
    lines.push(
      `Accepted slot: slot=${a.start_time} provider_id=${a.provider_id} location_id=${a.location_id}` +
        ` appointment_type_id=${a.appointment_type_id}` +
        (a.payable_with?.length ? ` payable_with=${a.payable_with.join(',')}` : ''),
    );
  } else if (state.quoted.length > 0) lines.push(`Quoted, none accepted: ${state.quoted.map((s) => s.start_time).join(', ')}`);

  return lines.join('\n');
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
