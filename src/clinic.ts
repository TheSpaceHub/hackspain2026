import { config } from './config.js';

/**
 * The catalogue: generated once and identical all event, so fetched once and shared.
 *
 * v0 does no lookups during a call. This exists solely for STT keyterm biasing — a
 * misheard surname or insurer is a lost case.
 */

export interface Clinic {
  keyterms: string[];
  /** Compact standing facts for the decider. Static all event, so it costs one fetch. */
  briefing: string;
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
    return {
      keyterms: keyterms.length > 0 ? keyterms : FALLBACK_KEYTERMS,
      briefing: buildBriefing(raw),
      raw,
      source: 'api',
    };
  } catch (err) {
    console.warn(`[clinic] fetch failed (${String(err)}); using documented facts`);
    return { keyterms: FALLBACK_KEYTERMS, briefing: '', raw: null, source: 'fallback' };
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

interface Named { id?: string; name?: string; [k: string]: unknown }

/** The standing rules a transcript can be judged against without any per-call lookup. */
function buildBriefing(raw: unknown): string {
  const c = (raw ?? {}) as Record<string, unknown>;
  const lines: string[] = [];

  const calendar = c.calendar as Record<string, unknown> | undefined;
  if (calendar) {
    lines.push(
      `Calendar: bookable ${String(calendar.starts)} to ${String(calendar.ends)}, ` +
        `${String(calendar.slot_minutes)}-minute slots. Closed: ${JSON.stringify(calendar.closure_days)}. ` +
        `Nothing opens on a Sunday, and only Arenal Centro opens on a Saturday. Nothing is booked same-day.`,
    );
  }

  const providers = (c.providers as Named[] | undefined) ?? [];
  const onLeave = providers.filter((p) => Array.isArray(p.leave) && (p.leave as unknown[]).length > 0);
  if (onLeave.length > 0) {
    lines.push(
      `Providers on leave: ${onLeave.map((p) => `${p.name} ${JSON.stringify(p.leave)}`).join('; ')}`,
    );
  }

  const specialties = (c.specialties as Named[] | undefined) ?? [];
  if (specialties.length > 0) {
    lines.push(
      `Specialties: ${specialties
        .map((s) => `${s.id} (${s.name}${s.min_age_months !== undefined || s.max_age_months !== undefined ? `, ages ${String(s.min_age_months ?? 0)}-${String(s.max_age_months ?? '')} months` : ''}${s.referral_required ? ', referral required' : ''})`)
        .join('; ')}`,
    );
  }

  const plans = (c.plans as Named[] | undefined) ?? [];
  if (plans.length > 0) {
    lines.push(
      `Insurance plan ids — submit the id, never the spoken name: ${plans
        .map((p) => `${p.name} = ${p.id}`)
        .join('; ')}`,
    );
  }

  const restrictions = (c.restrictions as Named[] | undefined) ?? [];
  if (restrictions.length > 0) {
    lines.push(
      `Standing restrictions, each with the reason code it maps to:\n${restrictions
        .map((r) => `  - ${r.id}: ${String(r.explanation ?? r.title ?? '')}`)
        .join('\n')}`,
    );
  }

  return lines.join('\n');
}
