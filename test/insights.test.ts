/**
 * A finding has to be readable by someone who was not on the call: what went wrong,
 * why it went wrong, and the turns it was read off.
 */
import assert from 'node:assert/strict';

import type { Case } from '../mock/world/suite/types.js';
import type { CallOutcome } from '../testlab/dial.js';
import { insightsFor, issueDrafts, type CaseResult } from '../testlab/insights.js';

let failures = 0;
function ok(what: string, run: () => void): void {
  try {
    run();
    console.log(`PASS  ${what}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${what}: ${String(err instanceof Error ? err.message : err)}`);
  }
}

const kase: Case = {
  id: 'simple_booking-01',
  problem_id: 'simple_booking',
  problem: '1 · The Simple Booking',
  title: 'Earliest GP',
  summary: 'Marta wants the earliest general practice appointment.',
  origin: 'Written case; the expectation is computed from the diary.',
  language: 'en',
  from_number: '+34600000000',
  persona: {
    name: 'Marta Ruiz',
    voice: 'female',
    description: 'A regular.',
    data: { national_id: '12345678Z' },
    objectives: ['Book the earliest GP slot.'],
    turn_cap: 8,
  },
  caller_prompt: '',
  script: ['Hello.'],
  audio: { background: 'silence', signal_to_noise_db: null },
  protected: [],
  burst: 1,
  expected: { acceptable: [{ actions: [{ action: 'BOOK' }] }] },
};

const call: CallOutcome = {
  call_id: 'c1',
  from_number: kase.from_number,
  ok: true,
  error: undefined,
  frames_sent: 10,
  frames_received: 10,
  ms_to_first_audio: 300,
  clears: 0,
  caller: 'persona',
  behaviour: 'cooperative',
  vocabulary: 'plain',
  caller_prompt: 'be Marta',
  caller_turns: ['Hello.'],
  transcript: [
    { role: 'assistant', text: 'Clinic, good morning.', at: 0 },
    { role: 'user', text: 'I need to see a doctor.', at: 2_000 },
    { role: 'assistant', text: 'I cannot help with that.', at: 4_000 },
  ],
  wav_path: null,
  call_ms: 20_000,
};

const base: Omit<CaseResult, 'insights'> = {
  case_id: kase.id,
  problem_id: kase.problem_id,
  title: kase.title,
  behaviour: 'cooperative',
  vocabulary: 'plain',
  copy: 0,
  pass: false,
  grade: { pass: false, misses: ['no record — nothing was submitted'], variant: 0 },
  actions: [],
  leaked: [],
  call,
};

const found = insightsFor(kase, base);

ok('a failed call is diagnosed', () => {
  assert.ok(found.length > 0);
});

ok('every finding says why, not only what', () => {
  for (const i of found) assert.ok(i.why.length > 20, `${i.code} has no why`);
});

ok('and quotes the turns it was read off', () => {
  const quoted = found.flatMap((i) => i.evidence);
  assert.ok(quoted.some((l) => l.includes('I cannot help with that.')));
  assert.ok(quoted.every((l) => l.startsWith('caller') || l.startsWith('agent')));
});

ok('a missing record is not diagnosed as a wrong slot or the wrong patient', () => {
  const refused = insightsFor(kase, {
    ...base,
    actions: [{ action: 'NO_ACTION', reason: 'specialty_not_covered' }],
    grade: {
      pass: false,
      misses: [
        'action: expected "BOOK", got "NO_ACTION"',
        'patient_id: expected any value, got undefined',
        'slot.start_time: expected any value, got undefined',
      ],
      variant: 0,
    },
  });
  const codes = refused.map((i) => i.code);
  assert.ok(codes.includes('wrong_action'));
  assert.ok(!codes.includes('wrong_patient'), 'no patient was named, so nothing was mixed up');
  assert.ok(!codes.includes('wrong_slot'), 'no time was submitted, so nothing shifted');
});

ok('but a right record with a hole in it is', () => {
  const partial = insightsFor(kase, {
    ...base,
    actions: [{ action: 'BOOK' }],
    grade: { pass: false, misses: ['slot.start_time: expected any value, got undefined'], variant: 0 },
  });
  assert.ok(partial.some((i) => i.code === 'missing_field'));
});

ok('the issue carries the why and the transcript with it', () => {
  const [issue] = issueDrafts([{ ...base, insights: found }], new Map([[kase.id, kase]]));
  assert.ok(issue);
  assert.match(issue.body, /What goes wrong, and why/);
  assert.match(issue.body, /\*Why:\*/);
  assert.ok(issue.body.includes('I cannot help with that.'));
});

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
