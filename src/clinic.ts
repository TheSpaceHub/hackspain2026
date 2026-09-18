import { config } from './config.js';

/**
 * The catalogue: generated once and identical all event, so fetched once and shared.
 *
 * v0 does no lookups during a call. This exists solely for STT keyterm biasing — a
 * misheard surname or insurer is a lost case.
 */

export interface Clinic {
  keyterms: string[];
  raw: unknown;
  source: 'api' | 'fallback';
}

/** Used when /api/v1/clinic is unreachable, so a missing key degrades rather than blocks. */
const FALLBACK_KEYTERMS = [
  // The two near-miss pairs are the whole point of keyterms.
  'Sáez', 'Sáenz', 'Iglesias', 'Iglesia', 'Requena', 'Ortiz', 'Vilar', 'Cid',
  // Sites.
  'Arenal', 'Arenal Centro', 'Arenal Norte', 'Arenal Sur',
  // Insurers.
  'Sanitas', 'Adeslas', 'DKV', 'Caser', 'ASISA', 'Mapfre', 'Axa', 'Cigna', 'Generali', 'privado',
  // Specialties.
  'general practice', 'paediatrics', 'dermatology', 'orthopaedics', 'gynaecology', 'physiotherapy',
  // Identifiers the caller reads out.
  'DNI', 'NIE',
];

let cached: Promise<Clinic> | null = null;

export function loadClinic(): Promise<Clinic> {
  cached ??= fetchClinic();
  return cached;
}

async function fetchClinic(): Promise<Clinic> {
  try {
    const res = await fetch(`${config.prosper.baseUrl}/api/v1/clinic`, {
      headers: { 'X-Api-Key': config.prosper.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`clinic ${res.status}`);
    const raw = await res.json();
    const keyterms = buildKeyterms(raw);
    return { keyterms: keyterms.length > 0 ? keyterms : FALLBACK_KEYTERMS, raw, source: 'api' };
  } catch (err) {
    console.warn(`[clinic] fetch failed (${String(err)}); using documented keyterms`);
    return { keyterms: FALLBACK_KEYTERMS, raw: null, source: 'fallback' };
  }
}

/** Read defensively: a renamed field costs a few keyterms, never a boot. */
function buildKeyterms(raw: unknown): string[] {
  const terms = new Set<string>();
  const seen = new Set<unknown>();

  const NAME_FIELDS = ['name', 'display_name', 'full_name', 'surname', 'last_name', 'label', 'title'];
  const COLLECTIONS = [
    'providers', 'locations', 'specialties', 'insurance_plans', 'insurers',
    'appointment_types', 'sites', 'plans',
  ];

  const walk = (node: unknown, collection: string | null): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, collection);
      return;
    }

    const obj = node as Record<string, unknown>;
    if (collection) {
      for (const field of NAME_FIELDS) {
        const value = obj[field];
        // Only provider names split: the surname is what a caller says alone.
        if (typeof value === 'string') addName(terms, value, collection === 'providers');
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      walk(value, COLLECTIONS.includes(key) ? key : collection);
    }
  };

  walk(raw, null);
  for (const term of FALLBACK_KEYTERMS) terms.add(term);
  // Bounded list; the long tail is noise.
  return [...terms].slice(0, 100);
}

/** Boosting these biases STT toward words it already gets right. */
const COMMON_WORDS = new Set([
  'first', 'visit', 'review', 'session', 'assessment', 'practice', 'general',
  'clinic', 'centre', 'center', 'care', 'health', 'salud', 'plan', 'de', 'la', 'del',
]);

/** Contributes the full name and the surname that gets misheard. */
function addName(terms: Set<string>, value: string, splitParts: boolean): void {
  const cleaned = value.replace(/^(Dr\.?|Dra\.?|D\.?|Dña\.?)\s+/i, '').trim();
  if (cleaned.length < 2 || cleaned.length > 60) return;
  terms.add(cleaned);
  if (!splitParts) return;

  // Callers say "Doctor Sáenz", not "Doctor Marta".
  for (const part of cleaned.split(/\s+/).slice(1)) {
    if (part.length >= 3 && !COMMON_WORDS.has(part.toLowerCase())) terms.add(part);
  }
}
