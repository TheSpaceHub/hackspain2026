/**
 * The decider's output schema, against the shapes models actually returned.
 *
 * Every one of these floored a real call: a confidence of "low" failed the range check and
 * threw away a valid action, and a bare action with no envelope did the same. Tolerance
 * here is load-bearing — but it must not extend to an invalid reason or an empty list,
 * which are the two cases that have to keep failing.
 */

import { deciderOutputSchema } from '../src/schema.js';

const cases: [string, unknown][] = [
  ['confidence as "low"', { actions: [{ action: 'no_action', reason: 'out_of_scope' }], confidence: 'low' }],
  ['confidence as "0.9" string', { actions: [{ action: 'no_action', reason: 'out_of_scope' }], confidence: '0.9' }],
  ['confidence NaN', { actions: [{ action: 'no_action', reason: 'out_of_scope' }], confidence: Number.NaN }],
  ['confidence out of range', { actions: [{ action: 'no_action', reason: 'out_of_scope' }], confidence: 7 }],
  ['bare action, no envelope', { action: 'escalate', reason: 'medical_emergency', confidence: 'high' }],
  ['bare array', [{ action: 'no_action', reason: 'caller_not_authorised' }]],
  ['notes as an object', { actions: [{ action: 'no_action', reason: 'out_of_scope' }], notes: { why: 'x' } }],
  ['register missing dob/email', { actions: [{ action: 'register', given_name: 'Carmen', first_surname: 'Delgado', second_surname: 'Ruiz', national_id: '12345678Z' }] }],
  ['register with nulls', { actions: [{ action: 'register', given_name: 'A', first_surname: 'B', second_surname: null, national_id: '12345678Z', date_of_birth: null, phone: null, email: null, insurer: null }] }],
  ['two actions (problem 18)', { actions: [{ action: 'cancel', appointment_id: 'A1' }, { action: 'cancel', appointment_id: 'A2' }] }],
  ['REJECT: reason outside the vocabulary', { actions: [{ action: 'no_action', reason: 'because_i_said_so' }] }],
  ['REJECT: empty actions', { actions: [] }],
  ['REJECT: unknown action', { actions: [{ action: 'transfer', to: 'reception' }] }],
];

let failed = 0;
for (const [name, input] of cases) {
  const result = deciderOutputSchema.safeParse(input);
  const shouldFail = name.startsWith('REJECT');
  const ok = result.success !== shouldFail;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(failed === 0 ? `\nall ${cases.length} passed` : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
