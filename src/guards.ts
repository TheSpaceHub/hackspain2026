/**
 * The two rules the model is not allowed to get wrong.
 *
 * Both were tools in the first draft and are not: a red flag that the model may choose
 * not to call is not a safeguard, and an appointment type it may choose to pick is a
 * boolean off the record dressed up as a decision. They run over the transcript and the
 * lookups after the call, on the way to submission.
 */

import type { Action, Patient } from './schema.js';
import type { Availability } from './clinic-api.js';
import { callerAccepted, choosePolicy, saidTimes, sameClock, type CallState } from './call-state.js';

export function bookFromState(state: CallState): Extract<Action, { action: 'book' }> | undefined {
  let accepted = state.accepted;
  const matched = state.matched;
  const policy_id = choosePolicy(state);
  if (!accepted || !matched || !policy_id) return undefined;
  if (!state.quoted_spoken) return undefined;
  const callerText = state.last_caller_text ?? '';
  const callerDecision = callerAccepted(callerText);
  if (callerDecision === 'no') return undefined;
  const spokenMatches = [...new Set(
    saidTimes(callerText).flatMap((said) =>
      state.quoted.filter((quoted) => sameClock(quoted, said)),
    ),
  )];
  if (spokenMatches.length > 1) return undefined;
  if (spokenMatches.length === 1) accepted = spokenMatches[0]!;
  else if (callerDecision !== 'yes') return undefined;
  if (!state.caller_is_patient && state.matched_by === 'phone') return undefined;
  return {
    action: 'book',
    patient_id: matched.patient_id,
    provider_id: accepted.provider_id,
    location_id: accepted.location_id,
    appointment_type_id: accepted.appointment_type_id,
    slot: accepted.start_time,
    policy_id,
  };
}

export function overrideFlooredBooking(actions: Action[], state: CallState): Action[] {
  if (
    actions.length === 0 ||
    !actions.every((action) => action.action === 'no_action') ||
    actions.some(
      (action) => action.action === 'no_action' &&
        (action.reason === 'caller_not_authorised' || action.reason === 'medical_emergency'),
    )
  ) {
    return actions;
  }
  const booking = bookFromState(state);
  return booking ? [booking] : actions;
}

export type RedFlag =
  | 'chest_pain_breathless'
  | 'stroke_signs'
  | 'sudden_breathlessness'
  | 'uncontrolled_bleeding'
  | 'head_injury_confusion';

/**
 * Each of the five published cases needs two things said, not one word. "Chest pain" on
 * its own is an ordinary complaint and the clinic books it; with breathlessness it is a
 * 112 call. Escalating an ordinary complaint is as wrong as missing a real one.
 */
const RED_FLAGS: { flag: RedFlag; all: RegExp[] }[] = [
  {
    flag: 'chest_pain_breathless',
    all: [/\bchest\b/, /\b(pain|tight|tightness|pressure|crushing)\b/, /\b(breath|breathing|breathless|winded)\b/],
  },
  {
    flag: 'stroke_signs',
    all: [/\b(face|facial|mouth|eye)\b/, /\b(droop|drooping|drooped|fallen|numb|weak|weakness)\b/, /\b(arm|speech|slur|slurred|talk|words)\b/],
  },
  {
    flag: 'sudden_breathlessness',
    all: [/\b(sudden|suddenly|out of nowhere|all at once)\b/, /\b(can'?t|cannot|struggling to|unable to)\b/, /\bbreath|breathe\b/],
  },
  {
    flag: 'uncontrolled_bleeding',
    all: [/\b(bleed|bleeding|blood)\b/, /\b(heavy|heavily|badly|won'?t stop|will not stop|pouring|soaking)\b/],
  },
  {
    flag: 'head_injury_confusion',
    all: [/\b(head|skull)\b/, /\b(bang|banged|hit|knock|knocked|fell|injury)\b/, /\b(confus|vomit|sick|sickness|drowsy)\w*\b/],
  },
];

export interface EmergencyFinding {
  flag: RedFlag;
  /** The sentence that tripped it, for the call log — never for the caller. */
  evidence: string;
}

/** The first published case the transcript describes, if any. */
export function detectMedicalEmergency(transcript: string): EmergencyFinding | null {
  for (const sentence of transcript.split(/(?<=[.!?\n])\s+/)) {
    const text = sentence.toLowerCase();
    for (const { flag, all } of RED_FLAGS) {
      if (all.every((re) => re.test(text))) return { flag, evidence: sentence.trim() };
    }
  }
  return null;
}

/**
 * A call that described a red flag escalates and books nothing, whatever else was agreed
 * on it. Ordering matters: a booking submitted alongside the escalation is still a
 * booking the clinic has to honour.
 */
export function applyEmergencyGuard(actions: Action[], transcript: string): { actions: Action[]; finding: EmergencyFinding | null } {
  const finding = detectMedicalEmergency(transcript);
  if (!finding) return { actions, finding: null };
  return { actions: [{ action: 'escalate', reason: 'medical_emergency' }], finding };
}

/**
 * The model may name a plan the slot cannot be billed against. Correct it where the
 * diary said which plans work, and leave it alone where it did not: an unpayable plan
 * we replace with nothing is a booking lost outright.
 */
export function enforcePolicy<T extends Extract<Action, { action: 'book' | 'reschedule' }>>(
  action: T,
  state: CallState,
): { action: T; corrected: boolean } {
  const payable = state.accepted?.payable_with ?? [];
  const stated = action.policy_id?.trim().toLowerCase();
  const ok = stated !== undefined && stated !== '' && !PLACEHOLDER_POLICY.has(stated) &&
    (payable.length === 0 || payable.includes(action.policy_id));
  if (ok) return { action, corrected: false };
  const chosen = choosePolicy(state);
  if (!chosen || chosen === action.policy_id) return { action, corrected: false };
  return { action: { ...action, policy_id: chosen }, corrected: true };
}

const PLACEHOLDER_POLICY = new Set(['unknown', 'none', 'n/a', 'null', 'undefined']);

export type AppointmentKind = 'first_visit' | 'review';

/** Follows the record, never the caller's phrasing: they will call a review a check-up. */
export function appointmentKindFor(matched: Patient | null): AppointmentKind {
  return matched?.has_visited_before === true ? 'review' : 'first_visit';
}

/**
 * /availability already applied history and eligibility, so the type it returns is the
 * one to submit. Anything else the model produced is dropped rather than corrected: an
 * id we invented is an id the clinic rejects.
 */
export function enforceAppointmentType(
  action: Extract<Action, { action: 'book' }>,
  availability: Availability,
): { action: Extract<Action, { action: 'book' }>; corrected: boolean } {
  const id = availability.appointment_type?.id ?? availability.slots.find((s) => s.start_time === action.slot)?.appointment_type_id;
  if (!id || id === action.appointment_type_id) return { action, corrected: false };
  return { action: { ...action, appointment_type_id: id }, corrected: true };
}
