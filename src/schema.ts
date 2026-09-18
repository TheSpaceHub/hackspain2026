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

/** Accepts a bare action, or a bare array, as well as the documented envelope. */
export const deciderOutputSchema = z.preprocess((raw) => {
  if (Array.isArray(raw)) return { actions: raw };
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (!o.actions && typeof o.action === 'string') {
      const { confidence, notes, ...action } = o;
      return { actions: [action], confidence, notes };
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
