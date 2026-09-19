/**
 * The tool layer against the fake clinic: no network, no model, no key.
 *
 * Each case is one of the graded failure modes — a household line that identifies
 * nobody, a slot quoted aloud and then submitted with a different timestamp, a
 * restriction reported as "no availability", an appointment type the model picked.
 */

import { llm } from '@livekit/agents';
import { buildTools, speakTime } from '../src/agent-tools.js';
import { printedToolCall } from '../src/agent.js';
import {
  choosePolicy,
  createCallState,
  planId,
  readCallState,
  recordAccepted,
  recordMatch,
  recordQuote,
  recordRequest,
  setPlanVocabulary,
} from '../src/call-state.js';
import { bookFromState, enforcePolicy, overrideFlooredBooking } from '../src/guards.js';
import { applyPatch } from '../src/extract.js';
import { ClinicApi, catalogueSchema } from '../src/clinic-api.js';
import { FakeClinic, fakeCatalogue } from './fake-clinic.js';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
}

const catalogue = catalogueSchema.parse(fakeCatalogue);
const NOW = new Date('2026-10-07T10:00:00+02:00');
setPlanVocabulary([
  ...catalogue.plans,
  { id: 'cigna', name: 'Cigna' },
  { id: 'nueva_mutua_sanitaria', name: 'Nueva Mutua Sanitaria' },
  { id: 'mapfre', name: 'Mapfre Salud' },
]);

interface Harness {
  clinic: FakeClinic;
  api: ClinicApi;
  state: ReturnType<typeof createCallState>;
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
  availability: () => unknown;
}

function harness(
  options: ConstructorParameters<typeof FakeClinic>[0] = {},
  lastCallerText?: string,
): Harness {
  const clinic = new FakeClinic(options);
  const api = new ClinicApi({ baseUrl: 'https://fake.local', apiKey: 'k', fetch: clinic.fetch });
  const state = createCallState('call-test');
  let availability: unknown = null;
  const tools = buildTools({
    state,
    api,
    catalogue,
    now: () => NOW,
    lastCallerText: () => lastCallerText ?? state.last_caller_text,
    onAvailability: (a) => {
      availability = a;
    },
  }) as unknown as Record<string, llm.FunctionTool>;

  return {
    clinic,
    api,
    state,
    availability: () => availability,
    call: async (name, args = {}) => {
      const tool = tools[name];
      if (!tool) throw new Error(`no tool ${name}`);
      // Through the schema, as the live model's arguments go: a rejected call is a
      // silent turn, and it is the coercions that decide whether one is rejected.
      const schema = (tool as { parameters?: { parse(v: unknown): unknown } }).parameters;
      const parsed = schema?.parse ? schema.parse(args) : args;
      const result = await tool.execute(parsed as never, {} as never);
      return String(result);
    },
  };
}

{
  const refused = harness({}, 'Yes. Monday at 6 30 PM is fine');
  refused.state.quoted = [{
    provider_id: 'prov_gp',
    location_id: 'loc_centro',
    appointment_type_id: 'apt_review',
    start_time: '2026-10-12T09:15:00+02:00',
  }];
  refused.state.quoted_spoken = true;
  const response = await refused.call('accept_slot', { choice: 1 });
  check('a spoken time that was not offered is refused', /caller said 18:30/.test(response), true);
  check('a refused spoken time is not accepted', refused.state.accepted, null);

  const corrected = harness({}, 'the 9 15 please');
  corrected.state.quoted = [
    {
      provider_id: 'prov_gp',
      location_id: 'loc_centro',
      appointment_type_id: 'apt_review',
      start_time: '2026-10-12T11:45:00+02:00',
    },
    {
      provider_id: 'prov_gp',
      location_id: 'loc_centro',
      appointment_type_id: 'apt_review',
      start_time: '2026-10-12T09:15:00+02:00',
    },
  ];
  corrected.state.quoted_spoken = true;
  await corrected.call('accept_slot', { choice: 2 });
  check('a matching spoken time accepts the matching quoted slot', corrected.state.accepted?.start_time, corrected.state.quoted[1]!.start_time);

  const numeric = harness({}, 'Yes, that one');
  numeric.state.quoted = [corrected.state.quoted[0]!];
  numeric.state.quoted_spoken = true;
  await numeric.call('accept_slot', { choice: 1 });
  check('without a spoken time the numeric choice is honored', numeric.state.accepted?.start_time, numeric.state.quoted[0]!.start_time);

  // Ten silent callers were booked because the model "accepted" for them after a nudge.
  const silent = harness({}, undefined);
  silent.state.caller_turns = 2;
  recordQuote(silent.state, [corrected.state.quoted[0]!]);
  silent.state.quoted_spoken = true;
  const notYet = await silent.call('accept_slot', { choice: 1 });
  check('no caller turn since the quote: refused', /has not answered/.test(notYet), true);
  check('and nothing is held', silent.state.accepted, null);
  silent.state.caller_turns = 3;
  silent.state.last_caller_text = 'Yes, that one';
  await silent.call('accept_slot', { choice: 1 });
  check('once the caller has spoken the choice is honored', silent.state.accepted?.start_time, corrected.state.quoted[0]!.start_time);
}

// --- identification --------------------------------------------------------

{
  const h = harness();
  const found = await h.call('identify_patient', { name: 'Marta Ruiz', national_id: '12345678Z' });
  check('a directory hit is recorded, not read back', h.state.matched?.patient_id, 'pat_001');
  check('and the agent is told not to repeat it', /Do not read this back/.test(found), true);

  const two = await h.call('identify_patient', { phone: '600333444' });
  check('a shared household line identifies nobody', /date of birth/.test(two), true);
  check('and leaves the earlier match alone', h.state.matched?.patient_id, 'pat_001');

  const none = await h.call('identify_patient', { national_id: '00000000T' });
  check('an unknown id is a new patient, not an error', /new patient/.test(none), true);
}

{
  const h = harness();
  await h.call('find_slots', { when_phrase: 'as soon as possible', specialty_id: 'spec_gp' });
  check('a pre-identification quote has no patient binding', h.state.quoted[0]?.for_patient_id, undefined);
  await h.call('identify_patient', { name: 'Marta Ruiz', date_of_birth: '1985-03-14' });
  h.state.quoted_spoken = true;
  h.state.last_caller_text = 'Yes, that one';
  const refused = await h.call('accept_slot', { choice: 1 });
  check('a quote made before identification is refused', /looked up before we knew/.test(refused), true);
  check('a stale pre-identification quote is not accepted', h.state.accepted, null);

  await h.call('find_slots', { when_phrase: 'as soon as possible', specialty_id: 'spec_gp' });
  check('a new quote is bound to the identified patient', h.state.quoted[0]?.for_patient_id, 'pat_001');
  h.state.quoted_spoken = true;
  h.state.caller_turns++;
  h.state.last_caller_text = 'Yes, that one';
  await h.call('accept_slot', { choice: 1 });
  check('a quote for the identified patient can be accepted', h.state.accepted?.for_patient_id, 'pat_001');
}

// --- the diary -------------------------------------------------------------

{
  const h = harness();
  await h.call('identify_patient', { name: 'Marta Ruiz', date_of_birth: '1985-03-14' });
  const offered = await h.call('find_slots', { when_phrase: 'Thursday morning', specialty_id: 'spec_gp' });

  check('only the morning of the day they named is offered', h.state.quoted.map((s) => s.start_time), [
    '2026-10-08T09:00:00+02:00',
    '2026-10-08T11:00:00+02:00',
  ]);
  check('the times are spoken, never as ISO', /2026-10-08T/.test(offered), false);

  const quoted = h.state.quoted[1]!;
  h.state.caller_turns++; // the caller answers the offer
  h.state.quoted_spoken = true;
  h.state.last_caller_text = 'Yes, that one';
  await h.call('accept_slot', { choice: 2 });
  check('the accepted slot is the quoted string, character for character', h.state.accepted?.start_time, quoted.start_time);
  check('with the ids the diary gave', [h.state.accepted?.provider_id, h.state.accepted?.appointment_type_id], [quoted.provider_id, 'apt_review']);

  const notes = readCallState(h.state);
  check('the decider is handed the exact slot', notes.includes(`slot=${quoted.start_time}`), true);
  check('and the type the diary chose', notes.includes('appointment_type_id=apt_review'), true);

  check('a choice that was never offered is refused', /not one of the times/.test(await h.call('accept_slot', { choice: 7 })), true);

  // The model writes the number as a word of JSON as often as a number of it.
  await h.call('accept_slot', { choice: '1' });
  check('a choice sent as a string still lands', h.state.accepted?.start_time, h.state.quoted[0]!.start_time);
}

{
  const h = harness();
  // A patient the clinic has never seen gets the first-visit type, whatever is said.
  await h.call('identify_patient', { national_id: '48064716Y' });
  await h.call('find_slots', { when_phrase: 'as soon as possible', specialty_id: 'spec_derm' });
  check('a first-timer is offered a first visit', h.state.quoted[0]!.appointment_type_id, 'apt_first');
  check('the earliest search starts tomorrow, never today', h.state.quoted[0]!.start_time.slice(0, 10), '2026-10-08');
}

{
  const h = harness();
  recordRequest(h.state, { insurers: ['ASISA'] });
  await h.call('identify_patient', { national_id: '48064716Y' });
  const blocked = await h.call('find_slots', { when_phrase: 'next week', specialty_id: 'spec_physio' });
  check('a refusing insurer is reported as the rule, not as a full diary', /does not accept asisa/.test(blocked), true);
  check('and nothing is quoted', h.state.quoted.length, 0);
  check('and the restriction is kept in the call notes', h.state.request.blocked_by, 'D. Álvaro Cid does not accept asisa');
  check('and the decider can see the restriction', /Rule that stopped the diary: D\. Álvaro Cid does not accept asisa/.test(readCallState(h.state)), true);
}

{
  const h = harness({
    restriction: { provider_id: 'prov_iglesias', restriction: 'provider_not_in_network' },
  });
  recordRequest(h.state, { insurers: ['ASISA'] });
  const fallback = await h.call('find_slots', {
    when_phrase: 'next week',
    specialty_id: 'dermatology',
    provider_name: 'Dra. Elena Iglesias',
  });
  check('a blocked named provider triggers a provider-free retry', h.clinic.requests.filter((r) => r.path === '/api/v1/availability').length, 2);
  check('the fallback quotes a real alternative', h.state.quoted[0]?.provider_id, 'prov_saenz');
  check('the fallback response names the provider and plan', /Elena Iglesias.*asisa.*another dermatologist/.test(fallback), true);
}

{
  const h = harness({ fullDays: ['2026-10-08'] });
  const full = await h.call('find_slots', { when_phrase: 'Thursday', specialty_id: 'spec_gp' });
  check('a full day is a full day, not an invented time', /Nothing free/.test(full), true);
  check('and nothing is quoted off it', h.state.quoted.length, 0);

  const open = await h.call('find_slots', { when_phrase: 'as soon as possible', specialty_id: 'spec_gp' });
  check('the soonest search skips the full day', h.state.quoted[0]!.start_time.slice(0, 10), '2026-10-09');
  check('and offers that one alone, not a menu they can pick a later time off', h.state.quoted.length, 1);
  check('which is the one it read out', /Offer that one and no other/.test(open), true);
  check('an ordinary earliest search keeps its original wording', /The soonest there is:/.test(open), true);
  check('spoken, not as ISO', /2026-10-09T/.test(open), false);
}

{
  const h = harness();
  const closed = await h.call('find_slots', { when_phrase: 'Monday the twelfth of October', specialty_id: 'spec_gp' });
  check('the published closure moves them on, and they are told', /closed, so this is from 2026-10-12/.test(closed), true);
  check('onto the next open day', h.state.quoted[0]!.start_time.slice(0, 10), '2026-10-13');
}

// --- moving and cancelling --------------------------------------------------

{
  const h = harness();
  check('no appointment lookup before the patient is known', /Identify the patient first/.test(await h.call('list_appointments')), true);
  await h.call('identify_patient', { national_id: '12345678Z' });
  const listed = await h.call('list_appointments');
  check('the appointment is read out in words', /Tuesday 20 October/.test(listed), true);
  check('and its reference is kept for the submission', h.state.request.appointment_id, 'apt_9001');
}

// --- standing facts ---------------------------------------------------------

{
  const h = harness();
  const ambiguous = await h.call('find_slots', { when_phrase: 'tomorrow', provider_name: 'Sáe' });
  check('a name matching two doctors is a spelling request, not a guess', /spell the surname/.test(ambiguous), true);
  check('and nothing is looked up until it is answered', h.clinic.requests.some((r) => r.path === '/api/v1/availability'), false);

  const doctor = await h.call('clinic_fact', { doctor_name: 'Cid' });
  check('a doctor is described off the catalogue', /physiotherapy/.test(doctor), true);
  const garbled = await h.call('clinic_fact', { doctor_name: 'House' });
  check('a garbled doctor name asks for the spelling, never denies', /spell the surname/.test(garbled) && !/No doctor of that name/.test(garbled), true);
  check('a site closed that day says so', /closed that day/.test(await h.call('clinic_fact', { location_id: 'loc_norte', date: '2026-10-10' })), true);
}

// --- the caller is not the patient ------------------------------------------

{
  const h = harness();
  applyPatch(h.state, {
    caller_is_patient: false,
    caller_name: 'Ana',
    relationship: 'daughter',
    patient: { national_id: '1 2 3 4 5 6 7 8 A' },
  });
  check('the notes say whose appointment this is', /Caller is NOT the patient/.test(readCallState(h.state)), true);
  check('a malformed spelled-out id is not stored', h.state.patient.national_id, undefined);
  check('a bad check letter is dropped', h.state.patient.national_id, undefined);
}

// --- caching ----------------------------------------------------------------

{
  const clinic = new FakeClinic();
  const api = new ClinicApi({ baseUrl: 'https://fake.local', apiKey: 'k', fetch: clinic.fetch });
  api.primeCatalogue(fakeCatalogue);
  await api.getCatalogue();
  await api.getCatalogue();
  check('a primed catalogue is never fetched', clinic.requests.filter((r) => r.path === '/api/v1/clinic').length, 0);
}

check('a slot is spoken as a person says it', speakTime('2026-10-08T16:30:00+02:00'), 'Thursday 8 October, 4:30 pm');

// --- the caller is listening to this ----------------------------------------

{
  // A diary that never answers must not become silence on the line.
  const hang: typeof globalThis.fetch = () => new Promise(() => {});
  const api = new ClinicApi({ baseUrl: 'https://fake.local', apiKey: 'k', fetch: hang });
  const state = createCallState('call-slow');
  const tools = buildTools({ state, api, catalogue, now: () => NOW, timeoutMs: 50 }) as unknown as Record<
    string,
    llm.FunctionTool
  >;
  const t0 = Date.now();
  const said = String(
    await tools.find_slots!.execute({ when_phrase: 'tomorrow', specialty_id: 'general practice' } as never, {} as never),
  );
  check('a hanging lookup gives the agent a line to say', /taking too long/.test(said), true);
  check('and gives it quickly', Date.now() - t0 < 1000, true);

  const broken = new ClinicApi({
    baseUrl: 'https://fake.local',
    apiKey: 'k',
    fetch: async () => new Response('nope', { status: 500 }),
  });
  const failing = buildTools({ state: createCallState('call-500'), api: broken, catalogue, now: () => NOW }) as unknown as Record<
    string,
    llm.FunctionTool
  >;
  const onFail = String(await failing.identify_patient!.execute({ name: 'Marta Ruiz' } as never, {} as never));
  check('a failing lookup is admitted to, not invented around', /failed/.test(onFail), true);
}

// --- what a small model actually sends --------------------------------------

{
  const clinic = new FakeClinic();
  const api = new ClinicApi({ baseUrl: 'https://fake.local', apiKey: 'k', fetch: clinic.fetch });
  const state = createCallState('call-sloppy');
  const tools = buildTools({ state, api, catalogue, now: () => NOW }) as unknown as Record<string, llm.FunctionTool>;

  const near = String(
    await tools.nearest_site!.execute({ address: 'unknown' } as never, {} as never),
  );
  check('a placeholder address is bounced back as a question', /Ask them which street/.test(near), true);

  const identified = String(
    await tools.identify_patient!.execute({ name: 'unknown' } as never, {} as never),
  );
  check('and a placeholder name is never looked up', /Nothing to search on/.test(identified), true);
}

// --- words the model says, ids the diary takes -------------------------------

{
  const h = harness();
  const said = await h.call('find_slots', { when_phrase: 'tomorrow', specialty_id: 'general practice', location_id: 'Centro' });
  const asked = h.clinic.requests.find((r) => r.path === '/api/v1/availability');
  check('a spoken specialty is sent as its id', asked?.query.specialty_id?.[0], 'spec_gp');
  check('and a site by the name the caller uses', asked?.query.location_id?.[0], 'loc_centro');
  check('so the caller gets times, not an apology', /Offer these/.test(said), true);

  // The diary needs a department or a doctor: asking without either is a 422 the
  // caller hears as "the system is playing up".
  const loose = harness();
  const wizardry = await loose.call('find_slots', { when_phrase: 'tomorrow', specialty_id: 'wizardry' });
  const wide = loose.clinic.requests.find((r) => r.path === '/api/v1/availability');
  check('a specialty nobody has is dropped, not sent', wide, undefined);
  check('and the agent is told to ask which one', /Ask which one/.test(wizardry), true);

  const named = harness();
  const byDoctor = await named.call('find_slots', { when_phrase: 'tomorrow', provider_name: 'Sáez' });
  check('a named doctor is enough on its own', /Offer these/.test(byDoctor), true);

  // The burst sent "gynecology" and "sonita" straight through and got 404s and a 422.
  const misheard = harness();
  recordRequest(misheard.state, { insurers: ['sonitas', 'not an insurer'] });
  await misheard.call('find_slots', { when_phrase: 'tomorrow', specialty_id: 'dermatolagy' });
  const near = misheard.clinic.requests.find((r) => r.path === '/api/v1/availability');
  check('a specialty misheard by a letter still reaches the diary', near?.query.specialty_id?.[0], 'spec_derm');
  check('a misheard insurer is billed as the real one', near?.query.insurer, ['sanitas']);
}

// --- which plan the visit is billed to ---------------------------------------

{
  setPlanVocabulary([
    ...catalogue.plans,
    { id: 'cigna', name: 'Cigna' },
    { id: 'mapfre', name: 'Mapfre Salud' },
  ]);

  check('a plan said out loud is written down as the clinic bills it', planId('Sanitas'), 'sanitas');
  check('accents and all', planId('ASISA'), 'asisa');
  check('a plan nobody offers is dropped', planId('Wizard Cover'), '');
  check('a fuzzy ASISA is resolved to the real plan', planId('acisa'), 'asisa');
  check('a fuzzy Sanitas is resolved to the real plan', planId('Fenitas'), 'sanitas');
  check('a fuzzy Cigna is resolved to the real plan', planId('Signa'), 'cigna');
  check('a fuzzy Mapfre is resolved to the real plan', planId('Mafre Salud'), 'mapfre');
  check('a numeric placeholder plan is dropped', planId('1'), '');
  const heard = createCallState('call-heard-insurer');
  recordRequest(heard, { insurers: ['ACISA', '1'] });
  check('a heard insurer keeps only real plans', heard.request.insurers, ['asisa']);

  const h = harness();
  await h.call('identify_patient', { national_id: '12345678Z' });
  await h.call('find_slots', { when_phrase: 'tomorrow', specialty_id: 'general practice' });
  h.state.caller_turns++;
  h.state.quoted_spoken = true;
  h.state.last_caller_text = 'Yes, that one';
  const held = await h.call('accept_slot', { choice: 1 });
  check('the plan on the record bills the slot it can pay for', choosePolicy(h.state), 'sanitas');
  check('so the caller is not asked for a second policy', /other insurance/.test(held), false);
  check('and the decider is handed the id, not the list', /Billing: policy_id=sanitas/.test(readCallState(h.state)), true);

  const guarded = enforcePolicy(
    { action: 'book', patient_id: 'pat_001', provider_id: 'prov_gp', location_id: 'loc_centro', appointment_type_id: 'apt_review', slot: h.state.accepted!.start_time, policy_id: 'Sanitas Más' },
    h.state,
  );
  check('a plan the model dressed up is corrected to the payable one', guarded.action.policy_id, 'sanitas');
  check('and the correction is reported', guarded.corrected, true);

  const invented = enforcePolicy(
    { action: 'reschedule', appointment_id: 'apt_1', provider_id: 'prov_gp', location_id: 'loc_centro', appointment_type_id: 'apt_review', slot: h.state.accepted!.start_time, policy_id: 'unknown' },
    h.state,
  );
  check('a placeholder never reaches the clinic', invented.action.policy_id, 'sanitas');
}

{
  setPlanVocabulary([
    { id: 'dkv', name: 'DKV' },
    { id: 'sanitas', name: 'Sanitas' },
  ]);
  const state = createCallState('call-policy-order');
  recordMatch(state, {
    patient_id: 'pat-dkv',
    insurer: 'dkv',
  });
  recordRequest(state, { insurers: ['Sanitas'] });
  recordAccepted(state, {
    provider_id: 'prov',
    location_id: 'loc',
    appointment_type_id: 'apt',
    start_time: '2026-10-08T09:00:00+02:00',
    for_patient_id: 'pat-dkv',
    payable_with: ['dkv', 'sanitas'],
  });
  check('the matched record plan is primary when both plans pay', choosePolicy(state), 'dkv');
  state.accepted!.payable_with = ['sanitas'];
  check('the heard plan wins when it is the only payable plan', choosePolicy(state), 'sanitas');
}

{
  setPlanVocabulary(catalogue.plans);
  const state = createCallState('call-phone-third-party');
  recordMatch(state, {
    patient_id: 'pat_001',
    given_name: 'Marta',
    first_surname: 'Ruiz',
    has_visited_before: true,
    insurer: 'sanitas',
  }, undefined, 'phone');
  state.caller_is_patient = false;
  recordRequest(state, { insurers: ['sanitas'] });
  recordAccepted(state, {
    provider_id: 'prov_gp',
    location_id: 'loc_centro',
    appointment_type_id: 'apt_review',
    start_time: '2026-10-08T09:00:00+02:00',
    for_patient_id: 'pat_001',
    payable_with: ['sanitas'],
  });
  state.quoted_spoken = true;
  state.last_caller_text = 'Yes, that one';
  check('a third-party phone match cannot trigger fallback booking', bookFromState(state), undefined);
}

{
  setPlanVocabulary(catalogue.plans);
  const state = createCallState('call-fallback');
  recordMatch(state, {
    patient_id: 'pat_001',
    given_name: 'Marta',
    first_surname: 'Ruiz',
    has_visited_before: true,
    insurer: 'sanitas',
  });
  recordAccepted(state, {
    provider_id: 'prov_saez',
    location_id: 'loc_centro',
    appointment_type_id: 'apt_review',
    start_time: '2026-10-08T09:00:00+02:00',
    for_patient_id: 'pat_001',
    payable_with: ['sanitas'],
  });
  state.quoted_spoken = true;
  state.last_caller_text = 'Yes, that one';
  const floored = overrideFlooredBooking(
    [{ action: 'no_action', reason: 'referral_required' }],
    state,
  );
  check('an accepted slot turns a floored no-action into a booking', floored, [{
    action: 'book',
    patient_id: 'pat_001',
    provider_id: 'prov_saez',
    location_id: 'loc_centro',
    appointment_type_id: 'apt_review',
    slot: '2026-10-08T09:00:00+02:00',
    policy_id: 'sanitas',
  }]);
  check(
    'caller authorisation still outranks the booking fallback',
    overrideFlooredBooking([{ action: 'no_action', reason: 'caller_not_authorised' }], state),
    [{ action: 'no_action', reason: 'caller_not_authorised' }],
  );
  state.accepted = null;
  check(
    'without an accepted slot the decider action is unchanged',
    overrideFlooredBooking([{ action: 'no_action', reason: 'referral_required' }], state),
    [{ action: 'no_action', reason: 'referral_required' }],
  );
}

{
  // The second policy: the slot bills against a plan the patient's record does not carry.
  const h = harness();
  await h.call('identify_patient', { national_id: '12345678Z' });
  recordRequest(h.state, { insurers: ['Adeslas'] });
  await h.call('find_slots', { when_phrase: 'tomorrow', specialty_id: 'general practice' });
  h.state.caller_turns++;
  h.state.quoted_spoken = true;
  h.state.last_caller_text = 'Yes, that one';
  const held = await h.call('accept_slot', { choice: 1 });
  check('the plan the caller named on the call is the one billed', choosePolicy(h.state), 'adeslas');
  check('and the slot is still held', /Held/.test(held), true);

  const stranger = harness();
  await stranger.call('find_slots', { when_phrase: 'tomorrow', specialty_id: 'general practice' });
  stranger.state.caller_turns++;
  stranger.state.quoted_spoken = true;
  stranger.state.last_caller_text = 'Yes, that one';
  stranger.state.quoted[0]!.payable_with = ['asisa'];
  const asked = await stranger.call('accept_slot', { choice: 1 });
  check('a slot no known plan pays for makes the agent ask for another policy', /other insurance/.test(asked), true);
}

// --- a tool call it printed instead of making --------------------------------

{
  const known = new Set(['clinic_fact', 'find_slots']);
  const printed = printedToolCall('{"name": "clinic_fact", "parameters": {"doctor_name": "Cid"}}', known);
  check('a printed tool call is taken as the call it meant', printed?.name, 'clinic_fact');
  check('with its arguments', printed?.args, '{"doctor_name":"Cid"}');
  check('a tool nobody has is not invented', printedToolCall('{"name": "wire_money"}', known), null);
  check('and prose is left alone', printedToolCall('Good morning.', known), null);
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
