/**
 * The scratchpad extractor, with the model stubbed out.
 *
 * What is being tested is not the extraction — that is the model's job — but the three
 * things that protect the call from it: that nothing here ever blocks a turn, that a
 * placeholder or a hallucinated field cannot reach the notes, and that whatever did
 * land is on the notes by the time the decider reads them.
 */

import { applyPatch, createExtractor, parsePatch, type Complete } from '../src/extract.js';
import { createCallState, readCallState, recordMatch } from '../src/call-state.js';

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
{
  const parsed = parsePatch(
    '{"intent":"register","insurers":["1"],"language":null,"caller_name":null,"caller_is_patient":true,"patient":{"given_name":"Ana","email":null}}',
  );
  check('null fields no longer invalidate an otherwise valid patch', parsed?.intent, 'register');
  check('null top-level fields are dropped', 'language' in (parsed ?? {}), false);
  check('null caller names are dropped', 'caller_name' in (parsed ?? {}), false);
  check('non-null caller fields survive', parsed?.caller_is_patient, true);
}
{
  const parsed = parsePatch('{"patient":{"given_name":"Ana","email":null}}');
  check('nested nulls are dropped without losing the patient patch', parsed?.patient, { given_name: 'Ana' });
}

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
  applyPatch(state, { patient: { national_id: '4 8 0 6 4 7 1 6 y' }, insurers: ['1', 'Nueva Mutua Sanitaria'] });
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

{
  const state = createCallState('call-match');
  recordMatch(state, {
    patient_id: 'P1',
    given_name: 'Guillermo',
    first_surname: 'Torres',
    second_surname: 'Molina',
  });
  applyPatch(state, { patient: { given_name: 'Fernando', first_surname: 'Serrano' } });
  check('a caller contradicting the phone match drops it', state.matched, null);
  check('and keeps the name that contradicted it', state.phone_match_rejected, 'Fernando Serrano');

  const givenOnly = createCallState('call-match-given');
  recordMatch(givenOnly, { patient_id: 'P1', given_name: 'Guillermo', first_surname: 'Torres' });
  applyPatch(givenOnly, { patient: { given_name: 'Guillermo' } });
  check('a matching given name keeps the phone match', givenOnly.matched?.patient_id, 'P1');

  const stt = createCallState('call-match-stt');
  recordMatch(stt, { patient_id: 'P1', given_name: 'Guillermo', first_surname: 'Torres' });
  applyPatch(stt, { patient: { given_name: 'Gillermo', first_surname: 'Torres' } });
  check('a small STT name error keeps the phone match', stt.matched?.patient_id, 'P1');

  const thirdParty = createCallState('call-match-third-party');
  recordMatch(thirdParty, { patient_id: 'P1', given_name: 'Guillermo', first_surname: 'Torres' });
  applyPatch(thirdParty, {
    caller_is_patient: false,
    patient: { given_name: 'Fernando', first_surname: 'Serrano' },
  });
  check('a third-party patient name does not drop the phone match', thirdParty.matched?.patient_id, 'P1');
}

// --- a name the caller never said -------------------------------------------

{
  const heard = 'My name is Josefa Domínguez.';
  const state = createCallState('call-grounded');
  applyPatch(
    state,
    { patient: { given_name: 'Josefa', first_surname: 'Domínguez', second_surname: 'Navarro' } },
    heard,
  );
  check('what was said is written down', state.patient.first_surname, 'Domínguez');
  check('a second surname nobody gave is not', state.patient.second_surname, undefined);

  const copied = createCallState('call-copied');
  applyPatch(copied, { patient: { national_id: 'P00001' } }, "Yes. That's right.");
  check('an id lifted off the notes on a turn with no number in it is dropped', copied.patient.national_id, undefined);

  const words = createCallState('call-words');
  applyPatch(words, { patient: { phone: '600999888' } }, 'six hundred, nine nine nine, eight eight eight');
  check('a number said in words is still taken', words.patient.phone, '600999888');

  const spelled = createCallState('call-spelled');
  applyPatch(spelled, { patient: { national_id: '48064716Y' } }, 'It is 4 8 0 6 4 7 1 6 Y.');
  check('an id spelled out still counts as said', spelled.patient.national_id, '48064716Y');
}

{
  const state = createCallState('call-dob');
  applyPatch(state, { patient: { date_of_birth: '2001-09-19' } }, 'Um, 2001 19 19.');
  check('three numbers that are not a date are left off', state.patient.date_of_birth, undefined);

  applyPatch(state, { patient: { date_of_birth: '2001-09-19' } }, '19 September 2001.');
  check('a date with its month named is taken', state.patient.date_of_birth, '2001-09-19');

  const digits = createCallState('call-dob-2');
  applyPatch(digits, { patient: { date_of_birth: '2001-09-19' } }, '19 09 2001');
  check('and so is one said in digits', digits.patient.date_of_birth, '2001-09-19');
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
