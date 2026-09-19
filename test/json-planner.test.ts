import { JsonPlanner } from '../src/json-planner.js';
import { FLOOR_ACTION } from '../src/decider.js';
import { catalogueSchema } from '../src/clinic-api.js';
import { fakeCatalogue } from './fake-clinic.js';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` ${detail}`}`);
}

const catalogue = catalogueSchema.parse(fakeCatalogue);
const patient = {
  patient_id: 'P1',
  given_name: 'Ana',
  first_surname: 'Test',
  second_surname: null,
  national_id: '12345678Z',
  date_of_birth: '1980-01-01',
  phone: '600000000',
  has_visited_before: true,
  insurer: 'mapfre',
};
const api = {
  findPatient: async () => [patient],
  getPatientAppointments: async () => [],
  findAvailability: async () => ({ slots: [], providers: [], blocked: [] }),
} as never;

async function main(): Promise<void> {
  {
    const replies = [
      JSON.stringify({ tools: [{ tool: 'find_patient', args: { phone: '600000000' } }], say: 'ignored', draft: [] }),
      JSON.stringify({ tools: [], say: 'I found your record.', draft: [] }),
    ];
    const planner = new JsonPlanner({
      api,
      catalogue,
      now: () => new Date('2026-10-07T10:00:00+02:00'),
      complete: async () => replies.shift()!,
    });
    const say = await planner.turn([{ role: 'caller', text: 'I need an appointment.' }]);
    check('turn executes requested lookup and returns second round', say === 'I found your record.');
    check('turn records one evidence line', planner.evidence.lines.length === 1);
  }

  {
    let calls = 0;
    const planner = new JsonPlanner({
      api,
      catalogue,
      complete: async () => {
        calls++;
        return calls <= 4
          ? JSON.stringify({ tools: [{ tool: 'find_patient', args: { phone: '600000000' } }], say: 'ignored', draft: [] })
          : JSON.stringify({ tools: [], say: 'The final answer.', draft: [] });
      },
    });
    const say = await planner.turn([{ role: 'caller', text: 'Hello.' }]);
    check('turn forces no-tools final round', say === 'The final answer.' && calls === 5);
  }

  {
    const replies = [
      JSON.stringify({
        tools: [],
        say: '',
        draft: [
          {
            action: 'REGISTER',
            new_patient: {
              given_name: 'Ana',
              first_surname: 'Test',
              second_surname: '',
              national_id: '12 345 678 z',
              date_of_birth: '1980-01-01',
              phone: '600 000 000',
              email: 'ANA @ EXAMPLE.COM',
              insurer: 'MAPFRE',
            },
          },
          { action: 'NO_ACTION', reason: 'not_a_reason' },
        ],
      }),
    ];
    const planner = new JsonPlanner({
      api,
      catalogue,
      complete: async () => replies.shift()!,
    });
    const result = await planner.close([]);
    check('close maps nested register and unknown no-action reason', result.actions.some((a) => a.action === 'register' && a.national_id === '12345678Z') && result.actions.some((a) => a.action === 'no_action' && a.reason === 'out_of_scope'));
  }

  {
    const planner = new JsonPlanner({
      api,
      catalogue,
      complete: async () => JSON.stringify({
        tools: [],
        say: '',
        draft: [{
          action: 'BOOK',
          patient_id: 'P1',
          provider_id: 'prov_saez',
          slot: '2026-10-07T12:00:00+02:00',
          policy_id: 'mapfre',
        }],
      }),
    });
    planner.evidence.slotsSeen.set('2026-10-07T12:00:00+02:00|prov_saez', {
      provider_id: 'prov_saez',
      location_id: 'loc_centro',
      appointment_type_id: 'at_gp_review',
    });
    const result = await planner.close([]);
    check('close fills book fields from slotsSeen', result.actions.some((a) => a.action === 'book' && a.location_id === 'loc_centro' && a.appointment_type_id === 'at_gp_review'));
  }

  {
    const planner = new JsonPlanner({
      api,
      catalogue,
      complete: async () => JSON.stringify({ tools: [], say: '', draft: [] }),
    });
    const result = await planner.close([]);
    check('close uses floor action for empty draft', JSON.stringify(result.actions) === JSON.stringify([FLOOR_ACTION]));
  }

  if (failed > 0) process.exitCode = 1;
}

void main();
