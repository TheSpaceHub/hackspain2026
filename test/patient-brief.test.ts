import { buildPatientBrief, describeBrief } from '../src/patient-brief.js';
import { catalogueSchema } from '../src/clinic-api.js';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
}

const catalogue = catalogueSchema.parse({
  providers: [{
    id: 'PR05',
    name: 'Dra. Elena Iglesias',
    refused_insurers: [{ id: 'dkv' }],
  }],
  locations: [
    { id: 'centro', name: 'Arenal Centro' },
    { id: 'sur', name: 'Arenal Sur' },
  ],
  specialties: [
    { id: 'general_practice', name: 'General Practice', min_age_months: 168, max_age_months: null },
    { id: 'gynaecology', name: 'Gynaecology', min_age_months: 168, max_age_months: null },
    { id: 'dermatology', name: 'Dermatology', referral_required: true },
    { id: 'physiotherapy', name: 'Physiotherapy', referral_required: true },
  ],
  plans: [
    { id: 'dkv', name: 'DKV', uncovered_specialty_names: ['Physiotherapy'] },
    { id: 'asisa', name: 'ASISA', uncovered_location_names: ['Arenal Sur'] },
  ],
});
const now = new Date('2026-10-07T10:00:00Z');

{
  const brief = buildPatientBrief({
    patient_id: 'P1',
    given_name: 'Roberto',
    date_of_birth: '1997-05-10',
    has_visited_before: true,
    insurer: 'dkv',
    referrals: ['dermatology'],
  }, catalogue, now);
  check('Roberto has the recorded plan', brief.plan?.id, 'dkv');
  check('Roberto has review visit kind', brief.visit_kind, 'review');
  check('Roberto has uncovered physiotherapy', brief.uncovered_specialties.map((s) => s.id), ['physiotherapy']);
  check('Roberto has the refusing provider', brief.refusing_providers.map((p) => p.id), ['PR05']);
  check('Roberto needs physiotherapy referral but not dermatology', brief.referral_missing.map((s) => s.id), ['physiotherapy']);
}

{
  const brief = buildPatientBrief({
    patient_id: 'P2',
    insurer: 'asisa',
  }, catalogue, now);
  check('Carmen has uncovered Sur', brief.uncovered_locations.map((l) => l.id), ['sur']);
}

{
  const brief = buildPatientBrief({
    patient_id: 'P3',
    date_of_birth: '2016-01-01',
  }, catalogue, now);
  check('a ten-year-old cannot use adult specialties', brief.age_ineligible_specialties.map((s) => s.id), ['general_practice', 'gynaecology']);
}

{
  const brief = buildPatientBrief({ patient_id: 'P4' }, catalogue, now);
  check('no DOB and no plan produces no brief text', describeBrief(brief), '');
}

if (failed) throw new Error(`${failed} patient brief checks failed`);
