/**
 * The tool layer against the fake clinic: no network, no model, no key.
 *
 * Each case is one of the graded failure modes — a household line that identifies
 * nobody, a slot quoted aloud and then submitted with a different timestamp, a
 * restriction reported as "no availability", an appointment type the model picked.
 */

import { llm } from '@livekit/agents';
import { buildTools, speakTime } from '../src/agent-tools.js';
import { createCallState, readCallState } from '../src/call-state.js';
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
  await h.call('record_request', { insurers: ['ASISA'] });
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
  await h.call('record_third_party', { caller_is_patient: false, caller_name: 'Ana', relationship: 'daughter' });
  await h.call('record_patient_field', { field: 'national_id', value: '1 2 3 4 5 6 7 8 A' });
  const notes = await h.call('read_notes');
  check('the notes say whose appointment this is', /Caller is NOT the patient/.test(notes), true);
  check('a bad check letter is flagged to the agent', /should be Z/.test(readCallState(h.state)), false);
  check('and to the caller, at the point it is heard', /ask them for it once more/i.test(await h.call('record_patient_field', { field: 'national_id', value: '12345678A' })), true);
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

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
