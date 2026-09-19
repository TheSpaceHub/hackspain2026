/**
 * The scratchpad extractor, with the model stubbed out.
 *
 * What is being tested is not the extraction — that is the model's job — but the three
 * things that protect the call from it: that nothing here ever blocks a turn, that a
 * placeholder or a hallucinated field cannot reach the notes, and that whatever did
 * land is on the notes by the time the decider reads them.
 */

import { applyPatch, createExtractor, parsePatch, type Complete } from '../src/extract.js';
import { createCallState, readCallState } from '../src/call-state.js';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
}

const replying =
  (...bodies: string[]): Complete =>
  () =>
    Promise.resolve(bodies.shift() ?? '{}');

// --- parsing ----------------------------------------------------------------

check('a fenced answer is still JSON', parsePatch('```json\n{"intent":"book"}\n```')?.intent, 'book');
check('prose around it is ignored', parsePatch('Sure! {"intent":"cancel"} hope that helps')?.intent, 'cancel');
check('nothing usable is null, never a guess', parsePatch('I could not find anything'), null);
check('a key outside the schema is dropped, not fatal', parsePatch('{"intent":"book","mood":"cross"}')?.intent, 'book');
check('an invalid enum voids the patch rather than writing junk', parsePatch('{"intent":"chat"}'), null);

// --- what may reach the notes -----------------------------------------------

{
  const state = createCallState('call-1');
  applyPatch(state, {
    patient: { given_name: 'unknown', first_surname: 'Ruiz', national_id: 'n/a' },
    when_phrase: 'not provided',
    intent: 'book',
  });
  check('a placeholder name is never written down', state.patient.given_name, undefined);
  check('a real surname beside it is', state.patient.first_surname, 'Ruiz');
  check('a placeholder id is dropped', state.patient.national_id, undefined);
  check('a placeholder when is dropped', state.request.when_phrase, undefined);
  check('the intent beside them is kept', state.request.intent, 'book');
}

{
  const state = createCallState('call-2');
  applyPatch(state, { patient: { national_id: '4 8 0 6 4 7 1 6 y' }, insurers: ['Nueva Mutua Sanitaria'] });
  check('a spelled-out id is normalised on the way in', state.patient.national_id, '48064716Y');
  check('a spoken plan becomes its id', state.request.insurers, ['nueva_mutua_sanitaria']);

  applyPatch(state, { patient: { national_id: '4 8 0 6 4 7 1 6 Y' }, insurers: ['Nueva Mutua Sanitaria'] });
  check('a caller repeating themselves writes nothing twice', state.request.insurers, ['nueva_mutua_sanitaria']);
  check('and does not fill the journal', state.journal.filter((e) => e.field === 'national_id').length, 1);
}

{
  const state = createCallState('call-3');
  applyPatch(state, { patient: { given_name: 'Joaquín' } });
  applyPatch(state, { retracted: ['given_name'] });
  check('a correction takes the value back off the notes', state.patient.given_name, undefined);
  check('and leaves it in the journal', state.journal.some((e) => e.note === 'retracted'), true);
}

{
  const state = createCallState('call-4');
  applyPatch(state, { caller_is_patient: false, caller_name: 'Ana', relationship: 'daughter' });
  check('the notes say whose appointment it is', /Caller is NOT the patient/.test(readCallState(state)), true);
}

// --- and what it costs the caller -------------------------------------------

{
  const state = createCallState('call-5');
  let released = (): void => {};
  const extractor = createExtractor({
    state,
    complete: () =>
      new Promise<string>((resolve) => {
        released = () => resolve('{"patient":{"given_name":"Marta"}}');
      }),
  });

  const t0 = Date.now();
  extractor.observe('My name is Marta.');
  check('observing a turn returns immediately', Date.now() - t0 < 50, true);
  check('and the agent speaks before the write lands', state.patient.given_name, undefined);

  await new Promise((resolve) => setTimeout(resolve, 10));
  released();
  await extractor.settle(1_000);
  check('the close waits for it', state.patient.given_name, 'Marta');
}

{
  const state = createCallState('call-6');
  const extractor = createExtractor({
    state,
    complete: () => new Promise<string>(() => {}),
  });
  extractor.observe('Something the model will never answer about.');
  const t0 = Date.now();
  await extractor.settle(100);
  check('a hung extraction cannot hold the submission window', Date.now() - t0 < 1_000, true);
}

{
  // Two exchanges, answered out of order by the model: the later one must still win.
  const state = createCallState('call-7');
  const extractor = createExtractor({
    state,
    complete: replying('{"patient":{"phone":"600111222"}}', '{"patient":{"phone":"600999888"}}'),
  });
  extractor.observe('My number is six hundred, one one one, two two two.');
  extractor.observe('Sorry, that is the old one — it is six hundred, nine nine nine, eight eight eight.');
  await extractor.settle(1_000);
  check('the last thing the caller said is what is on the notes', state.patient.phone, '600999888');
}

{
  const state = createCallState('call-8');
  const errors: string[] = [];
  const extractor = createExtractor({
    state,
    complete: () => Promise.reject(new Error('http 500')),
    onError: (message) => errors.push(message),
  });
  extractor.observe('I would like an appointment.');
  await extractor.settle(1_000);
  check('a failed extraction is logged, not thrown into the call', errors.length, 1);
  check('and the notes are merely empty', state.request.intent, undefined);
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
