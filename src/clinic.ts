import { config } from './config.js';

/**
 * The catalogue. Generated once, identical for every team and every call for the
 * whole event, so it is fetched once at boot and cached forever — one of the two
 * things deliberately shared across sockets (the other is the VAD model).
 *
 * v0 does no clinic lookup during a call. The catalogue is here for exactly one
 * purpose: keyterm biasing for STT, which is the single highest-leverage speech
 * setting in the build. A misheard surname or insurer is a lost case.
 */

export interface Clinic {
  keyterms: string[];
  raw: unknown;
  source: 'api' | 'fallback';
}

/**
 * What the documentation names outright, used when /api/v1/clinic is unreachable
 * at boot so a missing key degrades the call rather than preventing it.
 */
const FALLBACK_KEYTERMS = [
  // The two near-miss provider pairs are the whole point of keyterms.
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

/**
 * Walk the catalogue for the names a caller says out loud. The response shape is
 * read defensively — a renamed field costs us a few keyterms, never a boot.
 */
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
        // Only a provider's name is worth breaking apart: the surname is what a
        // caller says on its own, and it is where the near-miss pairs live.
        if (typeof value === 'string') addName(terms, value, collection === 'providers');
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      walk(value, COLLECTIONS.includes(key) ? key : collection);
    }
  };

  walk(raw, null);
  for (const term of FALLBACK_KEYTERMS) terms.add(term);
  // Deepgram takes a bounded list; the long tail is noise.
  return [...terms].slice(0, 100);
}

/**
 * Ordinary English that happens to appear in a catalogue name. Boosting these
 * would bias the STT toward words it already recognises perfectly, at the
 * expense of the surnames we actually care about.
 */
const COMMON_WORDS = new Set([
  'first', 'visit', 'review', 'session', 'assessment', 'practice', 'general',
  'clinic', 'centre', 'center', 'care', 'health', 'salud', 'plan', 'de', 'la', 'del',
]);

/** "Dra. Carmen Iglesias" contributes both the full name and the surname that gets misheard. */
function addName(terms: Set<string>, value: string, splitParts: boolean): void {
  const cleaned = value.replace(/^(Dr\.?|Dra\.?|D\.?|Dña\.?)\s+/i, '').trim();
  if (cleaned.length < 2 || cleaned.length > 60) return;
  terms.add(cleaned);
  if (!splitParts) return;

  // Skip the given name: callers say "Doctor Sáenz", not "Doctor Marta".
  for (const part of cleaned.split(/\s+/).slice(1)) {
    if (part.length >= 3 && !COMMON_WORDS.has(part.toLowerCase())) terms.add(part);
  }
}
