/**
 * Meets the real clinic's patients.
 *
 * The directory will not list anyone: it answers a name, a national id, a phone or an
 * exact date of birth and nothing else. A birthday is the only key that needs no prior
 * knowledge, so the harvester walks dates across the age bands the eighteen problems
 * care about — a toddler for paediatrics, a teenager either side of the fourteenth
 * birthday, adults, the elderly — and keeps whoever answers.
 *
 * The result is cached on disk so a run costs nothing after the first.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RealClinic, type RealAppointment, type RealPatient } from './client.js';

export interface HarvestedPatient extends RealPatient {
  /** Age in whole years on the day the snapshot was taken. */
  age: number;
  upcoming: RealAppointment[];
  past: RealAppointment[];
}

export interface Snapshot {
  taken_at: string;
  base_url: string;
  clinic: Record<string, unknown>;
  providers: Record<string, unknown>[];
  locations: Record<string, unknown>[];
  specialties: Record<string, unknown>[];
  patients: HarvestedPatient[];
}

/** Age bands worth having on hand, with how many of each the suite wants. */
const BANDS: { id: string; min: number; max: number; want: number }[] = [
  { id: 'infant', min: 0, max: 5, want: 8 },
  { id: 'child', min: 6, max: 13, want: 10 },
  { id: 'teen', min: 14, max: 17, want: 8 },
  { id: 'adult', min: 18, max: 49, want: 30 },
  { id: 'older', min: 50, max: 69, want: 20 },
  { id: 'elderly', min: 70, max: 100, want: 14 },
];

function ageOn(dob: string, on: Date): number {
  const [y = 0, m = 1, d = 1] = dob.split('-').map(Number);
  let age = on.getUTCFullYear() - y;
  const month = on.getUTCMonth() + 1;
  if (month < m || (month === m && on.getUTCDate() < d)) age -= 1;
  return age;
}

function datesFor(band: { min: number; max: number }, today: Date, seed: number): string[] {
  const out: string[] = [];
  const startYear = today.getUTCFullYear() - band.max - 1;
  const endYear = today.getUTCFullYear() - band.min;
  let x = seed;
  const next = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let year = startYear; year <= endYear; year++) {
    for (let i = 0; i < 40; i++) {
      const month = 1 + Math.floor(next() * 12);
      const day = 1 + Math.floor(next() * 28);
      out.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  return out;
}

async function pool<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>, stop: () => boolean): Promise<R[]> {
  const out: R[] = [];
  let index = 0;
  const workers = Array.from({ length: width }, async () => {
    while (index < items.length && !stop()) {
      const item = items[index++]!;
      try {
        out.push(await fn(item));
      } catch {
        /* a refused birthday is not worth failing the harvest over */
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export async function harvest(opts: { width?: number; seed?: number } = {}): Promise<Snapshot> {
  const clinic = new RealClinic();
  const today = new Date();
  const [head, providers, locations, specialties] = await Promise.all([
    clinic.clinic(),
    clinic.providers(),
    clinic.locations(),
    clinic.specialties(),
  ]);

  const found = new Map<string, RealPatient>();
  for (const band of BANDS) {
    const before = [...found.values()].filter((p) => {
      const age = ageOn(p.date_of_birth, today);
      return age >= band.min && age <= band.max;
    }).length;
    let got = before;
    const dates = datesFor(band, today, opts.seed ?? 20260919);
    await pool(
      dates,
      opts.width ?? 6,
      async (date) => {
        const matches = await clinic.patientsBornOn(date);
        for (const m of matches) {
          if (found.has(m.patient_id)) continue;
          found.set(m.patient_id, m);
          got++;
        }
      },
      () => got >= band.want,
    );
    process.stderr.write(`[harvest] ${band.id}: ${got}/${band.want}\n`);
  }

  const patients: HarvestedPatient[] = [];
  await pool(
    [...found.values()],
    6,
    async (p) => {
      const [upcoming, past] = await Promise.all([clinic.appointments(p.patient_id, 'upcoming'), clinic.appointments(p.patient_id, 'past')]);
      patients.push({ ...p, age: ageOn(p.date_of_birth, today), upcoming, past });
    },
    () => false,
  );
  patients.sort((a, b) => a.patient_id.localeCompare(b.patient_id));

  return {
    taken_at: new Date().toISOString(),
    base_url: process.env.PROSPER_API_BASE_URL ?? '',
    clinic: head,
    providers,
    locations,
    specialties,
    patients,
  };
}

export const SNAPSHOT_PATH = process.env.TESTLAB_SNAPSHOT ?? '.cache/real-clinic.json';

export function readSnapshot(path = SNAPSHOT_PATH): Snapshot | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

export function writeSnapshot(snapshot: Snapshot, path = SNAPSHOT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

/** The cached snapshot, harvesting it first if this machine has never met the clinic. */
export async function loadSnapshot(path = SNAPSHOT_PATH): Promise<Snapshot> {
  const cached = readSnapshot(path);
  if (cached) return cached;
  const fresh = await harvest();
  writeSnapshot(fresh, path);
  return fresh;
}

if (process.argv[1]?.endsWith('harvest.ts')) {
  const snapshot = await harvest();
  writeSnapshot(snapshot);
  process.stderr.write(
    `[harvest] ${snapshot.patients.length} patients · ${snapshot.providers.length} providers · ${snapshot.locations.length} sites -> ${SNAPSHOT_PATH}\n`,
  );
}
