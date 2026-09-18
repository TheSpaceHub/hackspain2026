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
  z.object({
    action: z.literal('register'),
    given_name: z.string(),
    first_surname: z.string(),
    second_surname: z.string().nullable().optional(),
    national_id: z.string(),
    date_of_birth: z.string(),
    phone: z.string(),
    email: z.string().nullable().optional(),
    insurer: z.string(),
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
export const deciderOutputSchema = z.object({
  actions: z.array(actionSchema).min(1),
  confidence: z.number().min(0).max(1).optional(),
  notes: z.string().optional(),
});

export type DeciderOutput = z.infer<typeof deciderOutputSchema>;

/** Note the hyphen: `no_action` -> `/submit/no-action`. */
export const ROUTES: Record<Action['action'], string> = {
  register: 'register',
  book: 'book',
  reschedule: 'reschedule',
  cancel: 'cancel',
  no_action: 'no-action',
  escalate: 'escalate',
};
