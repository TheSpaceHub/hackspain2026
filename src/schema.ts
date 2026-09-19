import { z } from 'zod';

/** Closed vocabulary: the first eleven mirror the clinic's restrictions one for one. */
export const REASONS = [
  'not_eligible_age',
  'referral_required',
  'provider_not_in_network',
  'specialty_not_covered',
  'location_not_covered',
  'insurer_referral_required',
  'allowance_exhausted',
  'provider_on_leave',
  'location_hours',
  'type_not_offered',
  'patient_history',
  'no_availability',
  'clinic_closed',
  'patient_not_found',
  'provider_not_found',
  'caller_not_authorised',
  'out_of_scope',
  'medical_emergency',
] as const;

export const reasonSchema = z.enum(REASONS);
export type Reason = z.infer<typeof reasonSchema>;

/**
 * A patient record as the directory returns it. Read defensively: everything but the
 * id is nullable, because a row that parses with a missing field still books.
 */
export const patientSchema = z.object({
  /** e.g. `P00042` — the only identifier `book` accepts. */
  patient_id: z.string(),
  given_name: z.string().nullable().optional(),
  /** Two surnames, Spanish-style. */
  first_surname: z.string().nullable().optional(),
  second_surname: z.string().nullable().optional(),
  /** DNI or NIE. */
  national_id: z.string().nullable().optional(),
  /** The age boundary for specialty routing — the 14th birthday, in months. */
  date_of_birth: z.string().nullable().optional(),
  /** The line the clinic holds for them. */
  phone: z.string().nullable().optional(),
  sex: z.string().nullable().optional(),
  /** Decides `first_visit` vs `review`: the appointment type follows this, never the conversation. */
  has_visited_before: z.boolean().nullable().optional(),
  /**
   * Only the first plan. A second can exist in the data and appears nowhere on the
   * record — asking on the call is the only way to find it (problem 17).
   */
  insurer: z.string().nullable().optional(),
  /** Which referrals they hold, for the referral-gated specialties. */
  referrals: z.array(z.string()).nullable().optional(),
  /**
   * The receptionist's free-text note: recency, visit count, usual doctor, usual site,
   * and how to talk to them ("hard of hearing — speak slowly").
   */
  note: z.string().nullable().optional(),
  /** How this row was found, not part of the chart. */
  match_score: z.number().nullable().optional(),
  matched_fields: z.array(z.string()).nullable().optional(),
});

export type Patient = z.infer<typeof patientSchema>;

/** One variant per route. `call_id` is attached by the submit client, which owns it. */
export const actionSchema = z.discriminatedUnion('action', [
  // Nullable where a caller may genuinely never have said it: a partial record that
  // lands and logs beats a floored no_action that hides what was missing.
  z.object({
    action: z.literal('register'),
    given_name: z.string(),
    first_surname: z.string(),
    second_surname: z.string().nullable().optional(),
    national_id: z.string(),
    date_of_birth: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    insurer: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal('book'),
    patient_id: z.string(),
    provider_id: z.string(),
    location_id: z.string(),
    appointment_type_id: z.string(),
    slot: z.string(),
    policy_id: z.string(),
  }),
  z.object({
    action: z.literal('reschedule'),
    appointment_id: z.string(),
    provider_id: z.string(),
    location_id: z.string(),
    slot: z.string(),
    policy_id: z.string(),
  }),
  z.object({
    action: z.literal('cancel'),
    appointment_id: z.string(),
  }),
  z.object({
    action: z.literal('no_action'),
    reason: reasonSchema,
  }),
  z.object({
    action: z.literal('escalate'),
    reason: reasonSchema,
  }),
]);

export type Action = z.infer<typeof actionSchema>;

/** `confidence` and `notes` go in the call log, never on the wire. */
const deciderShape = z.object({
  actions: z.array(actionSchema).min(1),
  // Advisory only, and never a reason to reject an otherwise valid action: anything
  // unparseable becomes undefined rather than failing the whole decision.
  confidence: z
    .preprocess((v) => {
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
    }, z.number().min(0).max(1).optional())
    .optional(),
  notes: z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().optional()).optional(),
});

/**
 * Models nest an action's payload under a wrapper about as often as they send it flat —
 * the contract's own readback nests REGISTER under `new_patient`, so it is a fair guess.
 * A nested payload is a correct decision in the wrong shape; discarding it costs a record.
 */
const WRAPPERS = ['fields', 'new_patient', 'data', 'payload', 'parameters', 'args'];

function flattenAction(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const action = { ...(raw as Record<string, unknown>) };
  for (const key of WRAPPERS) {
    const nested = action[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      delete action[key];
      Object.assign(action, nested);
    }
  }
  return action;
}

/** Accepts a bare action, a bare array, or a nested payload, as well as the documented envelope. */
export const deciderOutputSchema = z.preprocess((raw) => {
  if (Array.isArray(raw)) return { actions: raw.map(flattenAction) };
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.actions)) return { ...o, actions: o.actions.map(flattenAction) };
    if (typeof o.action === 'string') {
      const { confidence, notes, ...action } = o;
      return { actions: [flattenAction(action)], confidence, notes };
    }
  }
  return raw;
}, deciderShape);

export type DeciderOutput = z.infer<typeof deciderShape>;

/** Note the hyphen: `no_action` -> `/submit/no-action`. */
export const ROUTES: Record<Action['action'], string> = {
  register: 'register',
  book: 'book',
  reschedule: 'reschedule',
  cancel: 'cancel',
  no_action: 'no-action',
  escalate: 'escalate',
};

/**
 * The same contract as a JSON Schema, for Workers AI JSON Mode. The tolerant preprocess
 * above stays regardless: JSON Mode is unsupported on some models and can fail on a
 * complex schema, and a decision in the wrong shape is still a decision.
 */
export const deciderJsonSchema = z.toJSONSchema(deciderShape, { io: 'input' });
