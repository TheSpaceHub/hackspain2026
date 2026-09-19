/**
 * The whole invented clinic, built once at boot: the real catalogue, invented
 * patients, invented diaries. Same seed, same world, on every machine.
 */
import { todayMadrid } from '../rules/time.js';
import { type Catalogue, catalogue } from './catalogue.js';
import { type Diary, writeDiaries } from './diary.js';
import { generatePatients, type Patient } from './people.js';
import { createRandom } from './random.js';

export interface World {
  catalogue: Catalogue;
  patients: Patient[];
  patient: (id: string) => Patient | undefined;
  diary: Diary;
  /** Appointment ids the scenarios point at, fixed for this boot. */
  anchorAppointments: Record<string, string>;
  seed: number;
}

export function buildWorld(seed: number, crowd: number): World {
  const r = createRandom(seed);
  const patients = generatePatients(r, crowd);
  const { diary, anchorAppointments } = writeDiaries(r, catalogue, patients, todayMadrid());
  const byId = new Map(patients.map((p) => [p.patient_id, p]));
  return {
    catalogue,
    patients,
    patient: (id) => byId.get(id),
    diary,
    anchorAppointments,
    seed,
  };
}
