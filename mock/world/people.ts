/**
 * Invented patients. Everything here is made up, generated from a seed so every
 * machine holds the same people with the same ids.
 *
 * Two kinds:
 * - Anchors: a handful of fixed patients the harness scenarios are written
 *   against (scenarios.ts). Their ids, ids-on-paper and phones never change.
 * - The crowd: a few hundred generated ones, with the traps the docs promise —
 *   namesakes born in the same decade, national ids one digit apart.
 */
import { makeDni, makeNie } from '../rules/national-id.js';
import { INSURERS, type Insurer } from './catalogue.js';
import type { Random } from './random.js';

export interface Patient {
  patient_id: string;
  given_name: string;
  first_surname: string;
  second_surname: string;
  national_id: string;
  date_of_birth: string;
  /** Nine national digits, the way the directory holds it. */
  phone: string;
  sex: 'F' | 'M';
  has_visited_before: boolean;
  /** The plan on the record. */
  insurer: Insurer;
  referrals: string[];
  /** Written by diary.ts once the visit history exists — it is about that history. */
  note: string;
  /** How to talk to them; folded into the note. */
  manner: string | null;

  // --- never returned by the API ---------------------------------------------
  /** A second plan the caller holds but the record does not. Only asking finds it. */
  second_plan: Insurer | null;
  /** Visits spent this year against a capped plan, by specialty. */
  allowance_spent: Record<string, number>;
}

/** What /directory may show. The hidden fields stay in the mock. */
export type PublicPatient = Omit<Patient, 'manner' | 'second_plan' | 'allowance_spent'>;

export function toPublic(p: Patient): PublicPatient {
  const { manner: _m, second_plan: _s, allowance_spent: _a, ...rest } = p;
  return rest;
}

const GIVEN_F = [
  'María', 'Lucía', 'Carmen', 'Ana', 'Laura', 'Marta', 'Elena', 'Isabel', 'Paula', 'Sara', 'Cristina',
  'Pilar', 'Rosa', 'Nuria', 'Irene', 'Alba', 'Julia', 'Teresa', 'Beatriz', 'Montserrat', 'Silvia', 'Raquel',
];
const GIVEN_M = [
  'José', 'Antonio', 'Manuel', 'Francisco', 'David', 'Javier', 'Daniel', 'Carlos', 'Miguel', 'Alejandro',
  'Pablo', 'Sergio', 'Jorge', 'Alberto', 'Luis', 'Álvaro', 'Adrián', 'Diego', 'Raúl', 'Iván', 'Jordi', 'Pau',
];
const SURNAMES = [
  'García', 'Rodríguez', 'González', 'Fernández', 'López', 'Martínez', 'Sánchez', 'Pérez', 'Gómez', 'Martín',
  'Jiménez', 'Ruiz', 'Hernández', 'Díaz', 'Moreno', 'Muñoz', 'Álvarez', 'Romero', 'Alonso', 'Gutiérrez',
  'Navarro', 'Torres', 'Domínguez', 'Vázquez', 'Ramos', 'Gil', 'Ramírez', 'Serrano', 'Blanco', 'Molina',
  'Morales', 'Suárez', 'Ortega', 'Delgado', 'Castro', 'Ortiz', 'Rubio', 'Marín', 'Sanz', 'Iglesias', 'Núñez',
  'Medina', 'Garrido', 'Cortés', 'Castillo', 'Santos', 'Lozano', 'Guerrero', 'Cano', 'Prieto', 'Méndez',
  'Ibáñez', 'Puig', 'Ferrer', 'Vidal', 'Soler',
];
const MANNERS = [
  'Hard of hearing — speak slowly and clearly.',
  'Usually comes with a relative.',
  'Will ask what it costs under their policy before agreeing to anything.',
  'Prefers mornings; works afternoons.',
  'Nervous about appointments — reassure before giving times.',
  'Prefers to be spoken to in Spanish.',
  'Likes to confirm everything twice.',
  'Often calls on behalf of their mother as well.',
];

/** Weighted roughly like the real plan holders, so coverage traps come up as often. */
const PLAN_WEIGHTS: (readonly [Insurer, number])[] = [
  ['sanitas', 17], ['adeslas', 16], ['dkv', 12], ['asisa', 9], ['mapfre', 11],
  ['caser', 9], ['cigna', 7], ['axa', 7], ['nueva_mutua', 5], ['privado', 7],
];

// --- anchors ----------------------------------------------------------------

/**
 * Fixed patients for the harness scenarios. Phones 612345000… line up with the
 * harness's own caller ids, so `from_number` finds the anchor before a word is said.
 */
export const ANCHORS = {
  marta: 'P00001',
  jorge: 'P00002',
  pilar: 'P00003',
  antonio: 'P00004',
  elena: 'P00005',
  daniel: 'P00006',
} as const;

function anchors(): Patient[] {
  const base = {
    note: '',
    manner: null,
    second_plan: null,
    allowance_spent: {},
    referrals: [] as string[],
  };
  return [
    {
      ...base,
      patient_id: ANCHORS.marta,
      given_name: 'Marta', first_surname: 'Ruiz', second_surname: 'Gómez',
      national_id: '12345678Z', date_of_birth: '1988-04-12', phone: '612345000', sex: 'F',
      has_visited_before: true, insurer: 'sanitas',
    },
    {
      ...base,
      patient_id: ANCHORS.jorge,
      given_name: 'Jorge', first_surname: 'Navarro', second_surname: 'Ibáñez',
      national_id: makeDni('50231847'), date_of_birth: '1975-11-02', phone: '612345001', sex: 'M',
      has_visited_before: true, insurer: 'adeslas',
    },
    {
      ...base,
      patient_id: ANCHORS.pilar,
      given_name: 'Pilar', first_surname: 'Castro', second_surname: 'Serrano',
      national_id: makeDni('33719025'), date_of_birth: '1969-02-27', phone: '612345002', sex: 'F',
      // Caser covers no dermatology. She holds the referral, so that is the only rule that bites.
      has_visited_before: true, insurer: 'caser', referrals: ['dermatology'],
    },
    {
      ...base,
      patient_id: ANCHORS.antonio,
      given_name: 'Antonio', first_surname: 'Gil', second_surname: 'Ramos',
      national_id: makeDni('07462918'), date_of_birth: '1958-07-19', phone: '612345003', sex: 'M',
      has_visited_before: true, insurer: 'dkv',
    },
    {
      ...base,
      patient_id: ANCHORS.elena,
      given_name: 'Elena', first_surname: 'Ortega', second_surname: 'Ruiz',
      national_id: makeDni('46108357'), date_of_birth: '1986-09-03', phone: '612345004', sex: 'F',
      has_visited_before: true, insurer: 'mapfre', manner: 'Often calls on behalf of her son.',
    },
    {
      ...base,
      patient_id: ANCHORS.daniel,
      given_name: 'Daniel', first_surname: 'Molina', second_surname: 'Ortega',
      // Eight: paediatrics, and the caller is his mother, not him.
      national_id: makeDni('71840263'), date_of_birth: '2018-03-14', phone: '612345004', sex: 'M',
      has_visited_before: true, insurer: 'mapfre',
    },
  ];
}

// --- the crowd --------------------------------------------------------------

function isoDate(r: Random, fromYear: number, toYear: number): string {
  const y = r.int(fromYear, toYear);
  const m = r.int(1, 12);
  const d = r.int(1, 28);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function nationalId(r: Random): string {
  return r.chance(0.12) ? makeNie(r.pick(['X', 'Y', 'Z'] as const), r.digits(7)) : makeDni(r.digits(8));
}

function phone(r: Random, taken: Set<string>): string {
  for (;;) {
    const p = `${r.pick(['6', '7'])}${r.digits(8)}`;
    if (!taken.has(p)) {
      taken.add(p);
      return p;
    }
  }
}

function crowdPatient(r: Random, id: number, phones: Set<string>): Patient {
  const sex = r.chance(0.52) ? 'F' : 'M';
  // About one in six a child, so paediatrics and the age boundary both get traffic.
  const dob = r.chance(0.17) ? isoDate(r, 2013, 2025) : isoDate(r, 1938, 2007);
  const insurer = r.weighted(PLAN_WEIGHTS);
  const referrals = (['dermatology', 'orthopaedics', 'physiotherapy'] as const).filter(() => r.chance(0.22));
  const allowance_spent: Record<string, number> = {};
  // Some capped-plan holders have used their year up.
  if (insurer === 'mapfre' && r.chance(0.3)) allowance_spent.orthopaedics = 4;
  if (insurer === 'cigna' && r.chance(0.3)) allowance_spent.physiotherapy = 6;
  if (insurer === 'axa' && r.chance(0.3)) allowance_spent.physiotherapy = 8;

  return {
    patient_id: `P${String(id).padStart(5, '0')}`,
    given_name: r.pick(sex === 'F' ? GIVEN_F : GIVEN_M),
    first_surname: r.pick(SURNAMES),
    second_surname: r.pick(SURNAMES),
    national_id: nationalId(r),
    date_of_birth: dob,
    phone: phone(r, phones),
    sex,
    has_visited_before: r.chance(0.8),
    insurer,
    referrals: [...referrals],
    note: '',
    manner: r.chance(0.35) ? r.pick(MANNERS) : null,
    second_plan: r.chance(0.3) ? r.pick(INSURERS.filter((i) => i !== insurer)) : null,
    allowance_spent,
  };
}

/**
 * The traps, made on purpose rather than left to chance: four María Garcías born in
 * the same decade, and pairs of national ids a single digit apart — a confidently
 * misheard id returns a confidently wrong person.
 */
function traps(r: Random, next: () => number, phones: Set<string>): Patient[] {
  const out: Patient[] = [];
  for (const [second, dob] of [['López', '1971-03-08'], ['Sánchez', '1974-10-21'], ['Pérez', '1976-06-02'], ['Martín', '1979-12-15']] as const) {
    out.push({
      ...crowdPatient(r, next(), phones),
      given_name: 'María', first_surname: 'García', second_surname: second, sex: 'F', date_of_birth: dob,
    });
  }
  for (let i = 0; i < 6; i++) {
    const digits = r.digits(8);
    const twin = `${digits.slice(0, 7)}${(Number(digits[7]) + 1) % 10}`;
    out.push({ ...crowdPatient(r, next(), phones), national_id: makeDni(digits) });
    out.push({ ...crowdPatient(r, next(), phones), national_id: makeDni(twin) });
  }
  return out;
}

export function generatePatients(r: Random, crowd: number): Patient[] {
  const people = anchors();
  const phones = new Set(people.map((p) => p.phone));
  let id = people.length;
  const next = (): number => ++id;
  people.push(...traps(r, next, phones));
  while (people.length < crowd) people.push(crowdPatient(r, next(), phones));
  return people;
}
