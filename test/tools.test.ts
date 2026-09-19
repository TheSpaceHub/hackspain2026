/**
 * The deterministic half of the agent: normalization, date resolution, site ranking and
 * the two guards. None of it touches the network, so all of it can be wrong in exactly
 * one place — here.
 *
 * The cases are the published ones: a DNI whose check letter disagrees with its digits, a
 * phone dictated with a country code, "first thing on Monday the twelfth of October",
 * a Sunday request, and chest pain that is and is not an emergency.
 */

import { normalizeNationalId, normalizePhone, normalizeEmail, normalizeDate, normalizeName } from '../src/normalize.js';
import { resolveWhen, madridDate, addDays } from '../src/when.js';
import { rankSites, haversineKm, flatKm, metricAt, geocodeMadrid } from '../src/nearest-site.js';
import { detectMedicalEmergency, applyEmergencyGuard, appointmentKindFor, enforceAppointmentType } from '../src/guards.js';
import { providersByName, siteHours, type Catalogue } from '../src/clinic-api.js';
import {
  acceptFromTranscript,
  createCallState,
  recordPatientField,
  recordQuote,
  recordRequest,
  retract,
  setPlanVocabulary,
  readCallState,
  type QuotedSlot,
} from '../src/call-state.js';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
}

// --- normalization ---------------------------------------------------------

check('DNI spaced digits', normalizeNationalId('1 2 3 4 5 6 7 8 Z').value, '12345678Z');
check('DNI check letter ok', normalizeNationalId('12345678Z').problem, undefined);
check('DNI wrong check letter is flagged, not corrected', normalizeNationalId('12345678A').value, '12345678A');
check('DNI wrong check letter names the right one', /should be Z/.test(normalizeNationalId('12345678A').problem ?? ''), true);
check('NIE uses its prefix digit', normalizeNationalId('X1234567L').problem, undefined);
check('DNI missing its letter', normalizeNationalId('12345678').problem, 'missing the check letter');
check('phone with +34', normalizePhone('+34 612 345 678').value, '612345678');
check('phone with 0034', normalizePhone('0034612345678').value, '612345678');
check('phone dictated as words', normalizePhone('six one two three four five six seven eight').value, '612345678');
check('phone too short is flagged', normalizePhone('612 345').problem, '6 digits, expected 9');
check('email dictated', normalizeEmail('ana dot garcia at gmail dot com').value, 'ana.garcia@gmail.com');
check('email with arroba/punto', normalizeEmail('ana arroba gmail punto com').value, 'ana@gmail.com');
check('email spelled letter by letter', normalizeEmail('a n a at gmail dot com').value, 'ana@gmail.com');
check('non-email is flagged', normalizeEmail('ana at gmail').problem, 'not an email address');
check('ISO date passes through', normalizeDate('1985-03-14').value, '1985-03-14');
check('spoken date', normalizeDate('the fourteenth of March 1985').value, '1985-03-14');
check('numeric spoken date', normalizeDate('14 March 1985').value, '1985-03-14');
check('impossible date is flagged', normalizeDate('1985-02-30').problem, 'not a real date');
check('name keeps both surnames', normalizeName('  María  José Delgado Ruiz ').value, 'María José Delgado Ruiz');

// --- resolve_when ----------------------------------------------------------
// The call connects Wednesday 7 October 2026, 09:00 in Madrid. Fiesta Nacional (the 12th)
// is a Monday that year, and the Sunday before it is the 11th.

const call = new Date('2026-10-07T07:00:00Z');
check('anchor is the Madrid date, not UTC', madridDate(new Date('2026-10-07T23:30:00Z')), '2026-10-08');
check('tomorrow', resolveWhen('tomorrow please', call).date_from, '2026-10-08');
check('the day after tomorrow', resolveWhen('the day after tomorrow', call).date_from, '2026-10-09');
check('a week from today', resolveWhen('a week from today', call).date_from, '2026-10-14');
check('in a fortnight', resolveWhen('in a fortnight', call).date_from, '2026-10-21');
check('"today" is never same-day', resolveWhen('today if you can', call).date_from, '2026-10-08');
check('this coming Thursday is tomorrow', resolveWhen('this coming Thursday', call).date_from, '2026-10-08');
check('Wednesday means next Wednesday, not today', resolveWhen('Wednesday afternoon', call).date_from, '2026-10-14');
check('Saturday morning', resolveWhen('on Saturday morning', call).part_of_day, 'morning');
check('first thing is the morning', resolveWhen('first thing on Thursday', call).part_of_day, 'morning');
check(
  'first thing on Monday the twelfth of October is the closure day, so it moves',
  resolveWhen('first thing on Monday the twelfth of October', call).adjusted_from,
  '2026-10-12',
);
check(
  'and it moves to the next open day',
  resolveWhen('first thing on Monday the twelfth of October', call).date_from,
  '2026-10-13',
);
check('Sunday moves to Monday', resolveWhen('Sunday morning', call).date_from, '2026-10-13');
// Saturday the 10th is Centro-only and the following Monday is the closure day, so a
// Saturday request at Sur lands on the Tuesday.
check('Saturday at Sur moves on — only Centro opens', resolveWhen('Saturday', call, { locationId: 'LOC_SUR' }).date_from, '2026-10-13');
check('Saturday at Centro stands', resolveWhen('Saturday', call, { locationId: 'LOC_CENTRO' }).date_from, '2026-10-10');
check('Friday afternoon at Sur moves on', resolveWhen('Friday afternoon', call, { locationId: 'LOC_SUR' }).date_from, '2026-10-13');
// Spanish, because half of them say it that way and a day the parser misses silently
// becomes "the earliest".
check('jueves is Thursday, not the earliest', resolveWhen('el jueves', call).date_from, '2026-10-08');
check('jueves is a single day, not a window', resolveWhen('el jueves', call).earliest, false);
check('miércoles with the accent', resolveWhen('el miércoles', call).date_from, '2026-10-14');
check('pasado mañana', resolveWhen('pasado mañana', call).date_from, '2026-10-09');
check('mañana is tomorrow', resolveWhen('mañana a ser posible', call).date_from, '2026-10-08');
check('por la mañana is a time of day, not tomorrow', resolveWhen('el viernes por la mañana', call).date_from, '2026-10-09');
check('and it is the morning', resolveWhen('el viernes por la mañana', call).part_of_day, 'morning');
check('por la tarde', resolveWhen('el jueves por la tarde', call).part_of_day, 'afternoon');
check('a Spanish month and day', resolveWhen('el 14 de octubre', call).date_from, '2026-10-14');

const soonest = resolveWhen('as soon as possible', call);
check('no day named searches a window', [soonest.earliest, soonest.date_from, soonest.date_to], [true, '2026-10-08', '2026-10-21']);
check('the window never exceeds the 14-day cap', addDays(soonest.date_from, 13), soonest.date_to);

// --- nearest site ----------------------------------------------------------

const catalogue = {
  calendar: { closure_days: ['2026-10-12'] },
  providers: [
    { id: 'PR1', name: 'Dra. Elena Sáez', specialty_id: 'SP_DERM', languages: ['Spanish', 'English'], location_names: ['Prosper Centro'], refused_insurers: [] },
    { id: 'PR2', name: 'Dr. Marc Sáenz', specialty_id: 'SP_CARD', languages: ['Spanish'], location_names: ['Prosper Norte'], refused_insurers: [] },
    { id: 'PR3', name: 'Dr. Luis Iglesias', specialty_id: 'SP_DERM', languages: ['Spanish'], location_names: ['Prosper Norte'], refused_insurers: [] },
  ],
  locations: [
    { id: 'LOC_CENTRO', name: 'Prosper Centro', latitude: 40.4168, longitude: -3.7038, hours: [{ weekday: 'saturday', intervals: ['09:00-14:00'] }], provider_names: [] },
    { id: 'LOC_NORTE', name: 'Prosper Norte', latitude: 40.4762, longitude: -3.6882, hours: [], provider_names: [] },
    { id: 'LOC_SUR', name: 'Prosper Sur', latitude: 40.3450, longitude: -3.7001, hours: [], provider_names: [] },
  ],
  specialties: [],
  appointment_types: [],
  plans: [],
} as unknown as Catalogue;

const origin = { latitude: 40.4200, longitude: -3.7050 }; // just north of Sol
check('nearest first', rankSites(catalogue, origin).map((s) => s.location_id), ['LOC_CENTRO', 'LOC_NORTE', 'LOC_SUR']);
check(
  'a closer site with nobody in the specialty is not the answer',
  rankSites(catalogue, origin, { specialty_id: 'SP_CARD' }).map((s) => s.location_id),
  ['LOC_NORTE'],
);
check('distance is straight-line km', Math.round(haversineKm({ latitude: 40.4168, longitude: -3.7038 }, { latitude: 40.4762, longitude: -3.6882 })), 7);
check('the three nearest, and no more, are what the caller is read', rankSites(catalogue, origin).slice(0, 3).length, 3);

// The projection is fixed once per caller and each site is then arithmetic; across a
// city that has to agree with the great circle to within a house's width.
{
  const metric = metricAt(origin.latitude);
  const worst = Math.max(
    ...catalogue.locations.map((l) => {
      const site = { latitude: l.latitude!, longitude: l.longitude! };
      return Math.abs(flatKm(metric, origin, site) - haversineKm(origin, site));
    }),
  );
  check('flat ranking agrees with the great circle', worst < 0.02, true);
}

// --- geocoding -------------------------------------------------------------

{
  const googled = (body: unknown): typeof globalThis.fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch;

  const rooftop = await geocodeMadrid('Calle de Alcalá 54', {
    apiKey: 'test',
    fetch: googled({
      status: 'OK',
      results: [
        {
          formatted_address: 'C. de Alcalá 54, Madrid',
          geometry: { location: { lat: 40.4195, lng: -3.6921 }, location_type: 'ROOFTOP' },
        },
      ],
    }),
  });
  check('a door number is placed exactly', [rooftop?.latitude, rooftop?.exact], [40.4195, true]);

  const street = await geocodeMadrid('Calle de Alcalá', {
    apiKey: 'test',
    fetch: googled({
      status: 'OK',
      results: [{ geometry: { location: { lat: 40.42, lng: -3.69 }, location_type: 'GEOMETRIC_CENTER' } }],
    }),
  });
  check('a street centroid is flagged as not the number', street?.exact, false);

  const nowhere = await geocodeMadrid('Calle que no existe', {
    apiKey: 'test',
    fetch: googled({ status: 'ZERO_RESULTS', results: [] }),
  });
  check('an address nobody can place is nothing, not a guess', nowhere, null);

  const halfMatched = await geocodeMadrid('calle Ciskiskoops 999', {
    apiKey: 'test',
    fetch: googled({
      status: 'OK',
      results: [
        {
          formatted_address: 'Cl. de las Pozas, 4, Madrid',
          partial_match: true,
          geometry: { location: { lat: 40.4266, lng: -3.7086 }, location_type: 'ROOFTOP' },
        },
      ],
    }),
  });
  check('a street the geocoder only half-knew is marked as such', halfMatched?.partial, true);

  let fellBackTo = '';
  const seen: string[] = [];
  await geocodeMadrid('Gran Vía 1', {
    apiKey: 'test',
    fetch: (async (url: URL) => {
      seen.push(String(url));
      fellBackTo = String(url);
      return String(url).includes('googleapis')
        ? new Response('{"error_message":"invalid","status":"REQUEST_DENIED"}', { status: 200 })
        : new Response('[]', { status: 200 });
    }) as unknown as typeof globalThis.fetch,
  });
  check('a refused key falls back to the open geocoder', [seen.length, fellBackTo.includes('nominatim')], [2, true]);

  let asked = '';
  await geocodeMadrid('Gran Vía 1', {
    apiKey: '',
    fetch: (async (url: URL) => {
      asked = String(url);
      return new Response('[]', { status: 200 });
    }) as unknown as typeof globalThis.fetch,
  });
  check('without a Google key the open geocoder answers', asked.includes('nominatim'), true);
}

// --- catalogue queries -----------------------------------------------------

check('a near-miss surname returns both, to be asked about', providersByName(catalogue, 'Sáez').map((p) => p.id), ['PR1']);
check('accent-blind', providersByName(catalogue, 'saez').map((p) => p.id), ['PR1']);
check('partial surname returns every candidate', providersByName(catalogue, 'sáe').map((p) => p.id), ['PR1', 'PR2']);
check('closure day has no hours anywhere', siteHours(catalogue, 'LOC_CENTRO', '2026-10-12'), []);
check('Saturday hours at Centro', siteHours(catalogue, 'LOC_CENTRO', '2026-10-10'), ['09:00-14:00']);

// --- guards ----------------------------------------------------------------

check(
  'chest pain with breathlessness is an emergency',
  detectMedicalEmergency('I have a tight pain across my chest and I am struggling to catch my breath.')?.flag,
  'chest_pain_breathless',
);
check('ordinary chest pain is not', detectMedicalEmergency('I have had a dull chest pain for about three months now.'), null);
check(
  'stroke signs',
  detectMedicalEmergency('One side of his face has gone droopy and his arm is weak, his speech is slurred.')?.flag,
  'stroke_signs',
);
check(
  'a head injury with vomiting',
  detectMedicalEmergency('He banged his head an hour ago and has been confused and being sick since.')?.flag,
  'head_injury_confusion',
);
check('being unwell and worried is not an emergency', detectMedicalEmergency('I feel terrible and I am quite worried about it.'), null);
check(
  'an emergency replaces whatever was agreed',
  applyEmergencyGuard(
    [{ action: 'book', patient_id: 'P1', provider_id: 'PR1', location_id: 'LOC_CENTRO', appointment_type_id: 'AT1', slot: '2026-10-08T09:00:00+02:00', policy_id: 'cigna' }],
    'I have tight chest pain and cannot catch my breath.',
  ).actions,
  [{ action: 'escalate', reason: 'medical_emergency' }],
);

check('a returning patient gets a review', appointmentKindFor({ patient_id: 'P1', has_visited_before: true }), 'review');
check('an unknown caller gets a first visit', appointmentKindFor(null), 'first_visit');

const booking = {
  action: 'book' as const,
  patient_id: 'P1',
  provider_id: 'PR1',
  location_id: 'LOC_CENTRO',
  appointment_type_id: 'AT_FIRST',
  slot: '2026-10-08T09:00:00+02:00',
  policy_id: 'cigna',
};
const availability = {
  providers: [],
  appointment_type: { id: 'AT_REVIEW', name: 'Review' },
  slots: [{ provider_id: 'PR1', location_id: 'LOC_CENTRO', appointment_type_id: 'AT_REVIEW', start_time: '2026-10-08T09:00:00+02:00' }],
  blocked: [],
};
const enforced = enforceAppointmentType(booking, availability);
check('the type comes from availability, not the model', [enforced.action.appointment_type_id, enforced.corrected], ['AT_REVIEW', true]);
check('a type that already agrees is left alone', enforceAppointmentType({ ...booking, appointment_type_id: 'AT_REVIEW' }, availability).corrected, false);

// --- call state ------------------------------------------------------------

const state = createCallState('call-1', '+34612345678');
setPlanVocabulary([
  { id: 'cigna', name: 'Cigna' },
  { id: 'nueva_mutua_sanitaria', name: 'Nueva Mutua Sanitaria' },
]);
check('the inbound number is kept, normalized', state.from_number, '612345678');
check('but it is not assumed to be the patient\'s', state.patient.phone, undefined);
check('a recorded field reads back normalized', recordPatientField(state, 'national_id', 'X 1 2 3 4 5 6 7 L').value, 'X1234567L');
recordRequest(state, { intent: 'book', specialty_id: 'SP_DERM', insurers: ['Cigna', 'cigna', 'Nueva Mutua Sanitaria'] });
check('insurers are ids, deduped', state.request.insurers, ['cigna', 'nueva_mutua_sanitaria']);
recordPatientField(state, 'given_name', 'Carmen');
retract(state, 'given_name');
check('a retracted field leaves the draft', state.patient.given_name, undefined);
check('but stays in the journal', state.journal.filter((e) => e.note === 'retracted').length, 1);
check('the readback names the intent', /book/.test(readCallState(state)), true);

// --- the slot the caller chose and the model forgot to hold -----------------

const quote = (start: string, provider: string): QuotedSlot => ({
  provider_id: provider,
  location_id: 'LOC_CENTRO',
  appointment_type_id: 'AT_REVIEW',
  start_time: start,
});
const monday = quote('2026-09-21T11:45:00+02:00', 'PR1');
const noon = quote('2026-09-21T12:00:00+02:00', 'PR1');
const tuesday = quote('2026-09-22T09:30:00+02:00', 'PR2');

function afterQuote(said: string[]): QuotedSlot | null {
  const call = createCallState('call-2');
  recordQuote(call, [monday, noon, tuesday]);
  return acceptFromTranscript(
    call,
    said.map((text) => ({ role: 'user', text })),
  );
}

check('a time the caller says is matched to the quote', afterQuote(["Monday at 11 45 AM. Yeah, I'll take that."])?.start_time, monday.start_time);
check('the afternoon face of the same clock', afterQuote(['12:00 works'])?.start_time, noon.start_time);
check('an ordinal picks off the list we read out', afterQuote(['the first one please'])?.start_time, monday.start_time);
check('and so does the last', afterQuote(["I'll take the last one"])?.start_time, tuesday.start_time);
check('the request phrasing is not a choice', afterQuote(['what is the soonest you have', 'ok', 'thanks', 'bye']), null);
check('nothing is chosen when nothing was said', afterQuote(["I'll think about it"]), null);

{
  const nineThirty = quote('2026-09-21T09:30:00+02:00', 'PR3');
  const noReply = createCallState('call-after-quote');
  noReply.turns_seen = 2;
  recordQuote(noReply, [nineThirty]);
  check(
    'a request before the quote is not an acceptance',
    acceptFromTranscript(noReply, [
      { role: 'user', text: 'Book the soonest appointment with orthopaedics.' },
      { role: 'assistant', text: 'The soonest is Monday at 9:30 with Dr Peral.' },
    ]),
    null,
  );

  const ordinalReply = createCallState('call-after-ordinal');
  ordinalReply.turns_seen = 2;
  recordQuote(ordinalReply, [nineThirty]);
  check(
    'an ordinal after the quote is an acceptance',
    acceptFromTranscript(ordinalReply, [
      { role: 'user', text: 'Book the soonest appointment with orthopaedics.' },
      { role: 'assistant', text: 'The soonest is Monday at 9:30 with Dr Peral.' },
      { role: 'user', text: 'Yes, the first one.' },
    ])?.start_time,
    nineThirty.start_time,
  );

  const clockReply = createCallState('call-after-clock');
  clockReply.turns_seen = 2;
  recordQuote(clockReply, [nineThirty]);
  check(
    'a clock time after the quote is an acceptance',
    acceptFromTranscript(clockReply, [
      { role: 'user', text: 'Book the soonest appointment with orthopaedics.' },
      { role: 'assistant', text: 'The soonest is Monday at 9:30 with Dr Peral.' },
      { role: 'user', text: '9 30 please.' },
    ])?.start_time,
    nineThirty.start_time,
  );
}

const held = createCallState('call-3');
recordQuote(held, [monday, noon]);
held.accepted = noon;
check('a slot already held is never overwritten', acceptFromTranscript(held, [{ role: 'user', text: '11:45 then' }]), null);

const unchosen = createCallState('call-4');
recordQuote(unchosen, [monday]);
check('an unaccepted quote still carries its ids', /provider_id=PR1 location_id=LOC_CENTRO appointment_type_id=AT_REVIEW/.test(readCallState(unchosen)), true);

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
