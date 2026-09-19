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
  recordRequest,
  setPlanVocabulary,
} from '../src/call-state.js';
import { enforcePolicy } from '../src/guards.js';
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

interface Harness {
  clinic: FakeClinic;
  api: ClinicApi;
  state: ReturnType<typeof createCallState>;
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
  availability: () => unknown;
}

function harness(options: ConstructorParameters<typeof FakeClinic>[0] = {}): Harness {
  const clinic = new FakeClinic(options);
  const api = new ClinicApi({ baseUrl: 'https://fake.local', apiKey: 'k', fetch: clinic.fetch });
  const state = createCallState('call-test');
  let availability: unknown = null;
  const tools = buildTools({
    state,
    api,
    catalogue,
    now: () => NOW,
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
      const result = await tool.execute(args as never, {} as never);
      return String(result);
    },
  };
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
  await h.call('accept_slot', { choice: 2 });
  check('the accepted slot is the quoted string, character for character', h.state.accepted?.start_time, quoted.start_time);
  check('with the ids the diary gave', [h.state.accepted?.provider_id, h.state.accepted?.appointment_type_id], [quoted.provider_id, 'apt_review']);

  const notes = readCallState(h.state);
  check('the decider is handed the exact slot', notes.includes(`slot=${quoted.start_time}`), true);
  check('and the type the diary chose', notes.includes('appointment_type_id=apt_review'), true);

  check('a choice that was never offered is refused', /not one of the times/.test(await h.call('accept_slot', { choice: 7 })), true);
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
}

{
  const h = harness({ fullDays: ['2026-10-08'] });
  const full = await h.call('find_slots', { when_phrase: 'Thursday', specialty_id: 'spec_gp' });
  check('a full day is a full day, not an invented time', /Nothing free/.test(full), true);
  check('and nothing is quoted off it', h.state.quoted.length, 0);

  const open = await h.call('find_slots', { when_phrase: 'as soon as possible', specialty_id: 'spec_gp' });
  check('the soonest search skips the full day', h.state.quoted[0]!.start_time.slice(0, 10), '2026-10-09');
  check('and offers three', h.state.quoted.length, 3);
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
  check('a name matching two doctors is a question, not a guess', /Ask which one/.test(ambiguous), true);
  check('and nothing is looked up until it is answered', h.clinic.requests.some((r) => r.path === '/api/v1/availability'), false);

  const doctor = await h.call('clinic_fact', { doctor_name: 'Cid' });
  check('a doctor is described off the catalogue', /physiotherapy/.test(doctor), true);
  check('the unknown doctor is admitted to', /No doctor of that name/.test(await h.call('clinic_fact', { doctor_name: 'House' })), true);
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
  check('a spelled-out id is joined up', h.state.patient.national_id, '12345678A');
  check('a bad check letter is kept, flagged, not dropped', h.state.journal.some((e) => e.field === 'national_id' && e.note !== undefined), true);
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
  const said = String(await tools.find_slots!.execute({ when_phrase: 'tomorrow' } as never, {} as never));
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

  const loose = harness();
  await loose.call('find_slots', { when_phrase: 'tomorrow', specialty_id: 'wizardry' });
  const wide = loose.clinic.requests.find((r) => r.path === '/api/v1/availability');
  check('a specialty nobody has is dropped, not sent', wide?.query.specialty_id, undefined);

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
  setPlanVocabulary(catalogue.plans);

  check('a plan said out loud is written down as the clinic bills it', planId('Sanitas'), 'sanitas');
  check('accents and all', planId('ASISA'), 'asisa');
  check('a plan nobody offers is kept as spoken, not swapped for a real one', planId('Wizard Cover'), 'wizard_cover');

  const h = harness();
  await h.call('identify_patient', { national_id: '12345678Z' });
  await h.call('find_slots', { when_phrase: 'tomorrow' });
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
  // The second policy: the slot bills against a plan the patient's record does not carry.
  const h = harness();
  await h.call('identify_patient', { national_id: '12345678Z' });
  recordRequest(h.state, { insurers: ['Adeslas'] });
  await h.call('find_slots', { when_phrase: 'tomorrow' });
  const held = await h.call('accept_slot', { choice: 1 });
  check('the plan the caller named on the call is the one billed', choosePolicy(h.state), 'adeslas');
  check('and the slot is still held', /Held/.test(held), true);

  const stranger = harness();
  await stranger.call('find_slots', { when_phrase: 'tomorrow' });
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
