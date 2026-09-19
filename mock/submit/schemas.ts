/**
 * The six submit bodies, validated the way the real API validates them — and when
 * one fails, answered with the same 422 shape its framework produces:
 *   {"detail":[{"loc":["body","reason"],"msg":"Input should be …","type":"enum"}]}
 * The body is checked before the call is looked up, as on the real server.
 */
import { z } from 'zod';
import { INSURERS } from '../world/catalogue.js';
import { nationalIdProblem, normaliseNationalId } from '../rules/national-id.js';

export const OUTCOME_REASONS = [
  'not_eligible_age', 'referral_required', 'provider_not_in_network', 'specialty_not_covered',
  'location_not_covered', 'insurer_referral_required', 'allowance_exhausted', 'provider_on_leave',
  'location_hours', 'type_not_offered', 'patient_history', 'no_availability', 'clinic_closed',
  'patient_not_found', 'provider_not_found', 'caller_not_authorised', 'out_of_scope', 'medical_emergency',
] as const;

const insurer = z.enum(INSURERS);
const reason = z.enum(OUTCOME_REASONS);
/** "Must carry an explicit timezone offset" — a naive timestamp is refused. */
const slot = z.iso.datetime({ offset: true, local: false });
const nationalId = z
  .string()
  .superRefine((v, ctx) => {
    const problem = nationalIdProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: `Value error, ${problem}` });
  })
  .transform(normaliseNationalId);

const call = { call_id: z.string().min(1) };

export const ROUTES = {
  register: z.object({
    ...call,
    given_name: z.string().min(1),
    first_surname: z.string().min(1),
    second_surname: z.string(),
    national_id: nationalId,
    date_of_birth: z.iso.date(),
    phone: z.string().min(1),
    email: z.string().min(1),
    insurer,
  }),
  book: z.object({
    ...call,
    patient_id: z.string().min(1),
    provider_id: z.string().min(1),
    location_id: z.string().min(1),
    appointment_type_id: z.string().min(1),
    slot,
    policy_id: insurer,
  }),
  reschedule: z.object({
    ...call,
    appointment_id: z.string().min(1),
    provider_id: z.string().min(1),
    location_id: z.string().min(1),
    slot,
    policy_id: insurer,
  }),
  cancel: z.object({ ...call, appointment_id: z.string().min(1) }),
  'no-action': z.object({ ...call, reason }),
  escalate: z.object({ ...call, reason }),
} as const;

export type Route = keyof typeof ROUTES;

export function isRoute(route: string): route is Route {
  return route in ROUTES;
}

/** A recorded action: the shape /submit echoes back and /submissions reads out. */
export type RecordedAction = { action: string } & Record<string, unknown>;

/** The request body, minus `call_id`, as the verb it records. */
export function toAction(route: Route, body: Record<string, unknown>): RecordedAction {
  const { call_id: _c, ...fields } = body;
  switch (route) {
    case 'register':
      return { action: 'REGISTER', new_patient: fields };
    case 'book':
      return { action: 'BOOK', ...fields };
    case 'reschedule':
      return { action: 'RESCHEDULE', ...fields };
    case 'cancel':
      return { action: 'CANCEL', ...fields };
    case 'no-action':
      return { action: 'NO_ACTION', ...fields };
    case 'escalate':
      return { action: 'ESCALATE', ...fields };
  }
}

export interface ValidationDetail {
  loc: (string | number)[];
  msg: string;
  type: string;
}

function detailType(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_type' && issue.input === undefined) return 'missing';
  if (issue.code === 'invalid_value') return 'enum';
  if (issue.code === 'invalid_format') return issue.format === 'datetime' ? 'datetime_parsing' : `${issue.format}_parsing`;
  if (issue.code === 'custom') return 'value_error';
  if (issue.code === 'too_small') return 'string_too_short';
  return issue.code;
}

function detailMsg(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_type' && issue.input === undefined) return 'Field required';
  if (issue.code === 'invalid_value') return `Input should be ${issue.values.map((v) => `'${String(v)}'`).join(', ')}`;
  if (issue.code === 'invalid_format' && issue.format === 'datetime') {
    return 'Input should be a valid datetime with an explicit timezone offset';
  }
  return issue.message;
}

export function toValidationDetail(error: z.ZodError): ValidationDetail[] {
  return error.issues.map((issue) => ({
    loc: ['body', ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))],
    msg: detailMsg(issue),
    type: detailType(issue),
  }));
}
