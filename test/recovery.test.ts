/**
 * The four defects that turned a burst of fifteen calls into fifteen `no_action`s:
 * printed tool calls that could not be salvaged, near-miss names sent to the API raw,
 * a matched caller asked who they were, and a decider action returned twice.
 *
 * Every case here is taken from a real call in `calls/`.
 */

import { firstJsonObject, fileOnCaller, printedToolCall } from '../src/agent.js';
import { closest, distance, fold, only } from '../src/fuzzy.js';
import { locationById, planByName, providersByName, specialtyByName } from '../src/clinic-api.js';
import { createCallState, recordMatch } from '../src/call-state.js';
import { withoutDuplicates } from '../src/decider.js';
import { catalogueSchema } from '../src/clinic-api.js';
import { fakeCatalogue } from './fake-clinic.js';

const catalogue = catalogueSchema.parse(fakeCatalogue);

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
}

// --- salvaging a printed tool call -----------------------------------------

const known = new Set(['find_slots', 'clinic_fact']);
const name = (text: string): string | null => printedToolCall(text, known)?.name ?? null;
const args = (text: string): string | undefined => printedToolCall(text, known)?.args;

check('a bare object is a call', name('{"name": "find_slots", "parameters": {"when_phrase": "tomorrow"}}'), 'find_slots');
check(
  'and so is one with the model talking after it',
  name('{"name": "find_slots", "parameters": {}} Let me see what I can find.'),
  'find_slots',
);
check('fenced', name('```json\n{"name": "find_slots", "parameters": {}}\n```'), 'find_slots');
check('behind a tool tag', name('<|python_tag|>{"name": "clinic_fact", "parameters": {}}'), 'clinic_fact');
check('arguments rather than parameters', name('{"name": "find_slots", "arguments": {}}'), 'find_slots');
check(
  'arguments written as a string',
  args('{"name": "find_slots", "arguments": "{\\"when_phrase\\":\\"monday\\"}"}'),
  '{"when_phrase":"monday"}',
);
check('wrapped in tool_calls', name('{"tool_calls": [{"function": {"name": "find_slots", "arguments": {}}}]}'), 'find_slots');
check('a brace inside a string does not end the object', name('{"name": "find_slots", "parameters": {"when_phrase": "a } brace"}}'), 'find_slots');
check('a tool we do not have is not a call', name('{"name": "delete_everything", "parameters": {}}'), null);
check('ordinary speech with a brace is not a call', name('the {thing} they wanted'), null);
check('truncated JSON is not a call', name('{"name": "find_slots", "parame'), null);
check('nothing to find', firstJsonObject('no braces here'), undefined);

// --- fuzzy matching --------------------------------------------------------

check('one deletion', distance('gynecology', 'gynaecology'), 1);
check('one transposition', distance('vilar', 'vliar'), 1);
check('accents fold away', fold('Dra. Marta Sáez'), 'dra. marta saez');

check(
  'the US spelling of a British specialty',
  only([{ item: 'gyn', aliases: ['gynaecology'] }], 'gynecology'),
  'gyn',
);
check('the specialty as the caller says it', specialtyByName(catalogue, 'general practice')?.id, 'spec_gp');
check('and by its id, underscores and all', specialtyByName(catalogue, 'general_practice')?.id, 'spec_gp');
check('misheard by a letter', specialtyByName(catalogue, 'dermatolagy')?.id, 'spec_derm');
check('a specialty the clinic does not have is dropped', specialtyByName(catalogue, 'cardiology'), undefined);
check('the abbreviation callers actually use', specialtyByName(catalogue, 'GP')?.id, 'spec_gp');
check('a lay word for the department', specialtyByName(catalogue, 'family doctor')?.id, 'spec_gp');
check('a shortened department name', specialtyByName(catalogue, 'physio')?.id, 'spec_physio');
check('and the same in Spanish', specialtyByName(catalogue, 'fisioterapia')?.id, 'spec_physio');

check('a misheard insurer resolves', planByName(catalogue, 'sonitas')?.id, 'sanitas');
check('an insurer that is nobody is dropped', planByName(catalogue, 'blueshield'), undefined);

check('the site they named', locationById(catalogue, 'Centro')?.id, 'loc_centro');
check('misheard site', locationById(catalogue, 'Arenal Nortte')?.id, 'loc_norte');
// Speech recognition mangles the half the sites share, not the half that tells them apart.
check('the clinic half heard as a name', locationById(catalogue, 'Reinaldo Centro')?.id, 'loc_centro');
check('and heard as initials', locationById(catalogue, 'RNL Centro')?.id, 'loc_centro');
check('the shared half alone picks no site', locationById(catalogue, 'Arenal'), undefined);
check('a site that is not ours is dropped', locationById(catalogue, 'Chamartín'), undefined);

check('a doctor said exactly', providersByName(catalogue, 'Sáez').map((p) => p.id), ['prov_saez']);
check(
  'a surname one letter off the other doctor stays with the one said',
  providersByName(catalogue, 'Saenz').map((p) => p.id),
  ['prov_saenz'],
);
check('a surname misheard by one letter still finds the doctor', providersByName(catalogue, 'Dr. Sid').map((p) => p.id), ['prov_cid']);
check('nobody of that name at all', providersByName(catalogue, 'Fernández'), []);

check('an ambiguous match is no match', only([
  { item: 'a', aliases: ['sanitas'] },
  { item: 'b', aliases: ['sanitax'] },
], 'sanitar'), undefined);
check('an exact match beats a near one', closest([
  { item: 'a', aliases: ['sanitas'] },
  { item: 'b', aliases: ['sanita'] },
], 'sanitas').map((m) => m.item), ['a']);
check('nothing within tolerance', closest([{ item: 'a', aliases: ['physiotherapy'] }], 'cardiology'), []);

// --- the file on a caller we already matched --------------------------------

const state = createCallState('call_1', '612345678');
check('no file before the lookup lands', fileOnCaller(state), undefined);

recordMatch(state, {
  patient_id: 'P01132',
  given_name: 'Juan',
  first_surname: 'Ruiz',
  second_surname: 'Moreno',
  has_visited_before: true,
  insurer: 'dkv',
});
const file = fileOnCaller(state) ?? '';
check('the file names them', /P01132.*Juan Ruiz Moreno/.test(file), true);
check('and says not to ask again', /do not ask for their name/.test(file), true);
check('and carries the plan on record', /dkv/.test(file), true);

// --- a decider that answers twice -------------------------------------------

const twice = withoutDuplicates({
  actions: [
    { action: 'no_action', reason: 'out_of_scope' },
    { action: 'no_action', reason: 'out_of_scope' },
  ],
  confidence: 0.4,
  notes: 'nothing was asked for',
});
check('the repeat is dropped', twice.actions.length, 1);

const both = withoutDuplicates({
  actions: [
    { action: 'cancel', appointment_id: 'A1' },
    { action: 'cancel', appointment_id: 'A2' },
  ],
  confidence: 0.9,
  notes: 'cancelled hers and her son’s',
});
check('two different cancellations are both kept', both.actions.length, 2);

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
