/**
 * GET /directory. A name is matched loosely and scored; every other field is exact
 * and *filters* — a national id that does not match excludes the patient rather
 * than ranking them lower, which is what makes name + date of birth the way to tell
 * namesakes apart, and a misheard id usually return nothing.
 */
import type { Patient, PublicPatient } from '../world/people.js';
import { toPublic } from '../world/people.js';
import { normaliseNationalId } from './national-id.js';

export interface DirectoryQuery {
  name?: string;
  national_id?: string;
  phone?: string;
  date_of_birth?: string;
}

export type PatientMatch = PublicPatient & { match_score: number; matched_fields: string[] };

const NAME_THRESHOLD = 0.72;
const MAX_MATCHES = 10;

export function normaliseText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** +34612345678, 0034612345678 and 612 34 56 78 are one number: its nine national digits. */
export function foldPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/** Jaro–Winkler: forgiving of the misspellings a transcript makes of a name. */
function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (bHit[j] || a[i] !== b[j]) continue;
      aHit[i] = bHit[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k++]) transpositions++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Each spoken token against its best counterpart in the record's three names. */
function nameScore(query: string, p: Patient): number {
  const want = normaliseText(query).split(' ').filter(Boolean);
  const have = normaliseText(`${p.given_name} ${p.first_surname} ${p.second_surname}`).split(' ');
  if (want.length === 0) return 0;
  const total = want.reduce((sum, w) => sum + Math.max(...have.map((h) => jaroWinkler(w, h))), 0);
  return Math.round((total / want.length) * 1000) / 1000;
}

/** Null when the query names nothing to search by. */
export function searchDirectory(patients: Patient[], q: DirectoryQuery): PatientMatch[] | null {
  if (!q.name && !q.national_id && !q.phone && !q.date_of_birth) return null;
  const id = q.national_id ? normaliseNationalId(q.national_id) : null;
  const phone = q.phone ? foldPhone(q.phone) : null;

  const matches: PatientMatch[] = [];
  for (const p of patients) {
    const fields: string[] = [];
    if (id) {
      if (p.national_id !== id) continue;
      fields.push('national_id');
    }
    if (phone) {
      if (p.phone !== phone) continue;
      fields.push('phone');
    }
    if (q.date_of_birth) {
      if (p.date_of_birth !== q.date_of_birth) continue;
      fields.push('date_of_birth');
    }
    let score = 1;
    if (q.name) {
      score = nameScore(q.name, p);
      if (score < NAME_THRESHOLD) continue;
      fields.unshift('name');
    }
    matches.push({ ...toPublic(p), match_score: score, matched_fields: fields });
  }
  return matches.sort((a, b) => b.match_score - a.match_score).slice(0, MAX_MATCHES);
}
