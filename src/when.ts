/**
 * "This coming Thursday" → a date range for /availability.
 *
 * Problem 5's vocabulary is fixed, and every phrase resolves against the moment the call
 * connects, in Europe/Madrid — not the machine's clock. The model is not asked to do this:
 * it hands over the caller's words and gets back the window to search.
 *
 * Three rules bend the answer after the arithmetic: nothing is booked same-day, the
 * network is shut on Sundays and on the published closure day, and only Centro opens on a
 * Saturday. A caller whose day turns out to be closed takes the earliest appointment on
 * the next open day that still matches the rest of what they asked for.
 */

export type PartOfDay = 'morning' | 'afternoon';

export interface WhenWindow {
  /** Inclusive, ISO date. /availability rejects a span longer than 14 days. */
  date_from: string;
  date_to: string;
  part_of_day?: PartOfDay;
  /** Set when the day the caller named was closed and we moved them on. */
  adjusted_from?: string;
  /** True when the caller named no day at all: search from tomorrow and take the first. */
  earliest: boolean;
}

export interface ResolveOptions {
  /** Site the request is pinned to, which decides Saturdays. */
  locationId?: string;
  /** Published closure days; defaults to Fiesta Nacional, the one for this event. */
  closureDays?: string[];
  /** Overrides the built-in rules — pass the catalogue's hours in production. */
  isOpen?: (isoDate: string, part?: PartOfDay) => boolean;
  /** /availability's cap. */
  maxSpanDays?: number;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const ORDINALS = [
  '', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth',
  'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth',
  'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first', 'twenty-second',
  'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh',
  'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first',
];

const DEFAULT_CLOSURE_DAYS = ['2026-10-12'];

export function resolveWhen(phrase: string, now: Date, options: ResolveOptions = {}): WhenWindow {
  const maxSpan = options.maxSpanDays ?? 14;
  const today = madridDate(now);
  const text = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
  const part = partOfDay(text);
  const isOpen = options.isOpen ?? defaultIsOpen(options);

  const named = namedDate(text, today) ?? relativeDate(text, today) ?? weekdayDate(text, today);

  // Nothing is booked same-day: the earliest is the day after the call.
  const earliestDay = addDays(today, 1);

  if (!named) {
    const from = firstOpenFrom(earliestDay, part, isOpen) ?? earliestDay;
    return { date_from: from, date_to: addDays(from, maxSpan - 1), part_of_day: part, earliest: true };
  }

  const wanted = named < earliestDay ? earliestDay : named;
  const open = firstOpenFrom(wanted, part, isOpen) ?? wanted;
  return {
    date_from: open,
    date_to: open,
    part_of_day: part,
    adjusted_from: open === wanted ? undefined : wanted,
    earliest: false,
  };
}

/** "morning" is before 14:00 and "afternoon" from 14:00; "first thing" is the morning. */
function partOfDay(text: string): PartOfDay | undefined {
  if (/\b(morning|first thing)\b/.test(text)) return 'morning';
  if (/\b(afternoon|evening)\b/.test(text)) return 'afternoon';
  return undefined;
}

/** "Monday the twelfth of October", "12 October", "the 3rd of November". */
function namedDate(rawText: string, today: string): string | null {
  // "first thing on Monday the twelfth" carries an ordinal that is not the day.
  const text = rawText.replace(/first thing/g, '');
  const month = MONTHS.findIndex((m) => text.includes(m));
  if (month === -1) return null;

  const ordinal = ORDINALS.findIndex((o, i) => i > 0 && new RegExp(`\\b${o}\\b`).test(text));
  const numeric = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text)?.[1];
  const day = ordinal > 0 ? ordinal : numeric ? Number(numeric) : NaN;
  if (!Number.isFinite(day)) return null;

  const [year] = today.split('-').map(Number) as [number];
  const candidate = iso(year, month + 1, day);
  // A month already behind us means next year, not a date in the past.
  return candidate >= today ? candidate : iso(year + 1, month + 1, day);
}

function relativeDate(text: string, today: string): string | null {
  if (/\bday after tomorrow\b/.test(text)) return addDays(today, 2);
  if (/\btomorrow\b/.test(text)) return addDays(today, 1);
  if (/\b(a week from today|in a week|next week today)\b/.test(text)) return addDays(today, 7);
  if (/\b(in a fortnight|two weeks from today)\b/.test(text)) return addDays(today, 14);
  if (/\btoday\b/.test(text)) return addDays(today, 1); // never same-day
  return null;
}

/** A weekday phrase means the first such weekday *strictly after* the day of the call. */
function weekdayDate(text: string, today: string): string | null {
  const weekday = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(text));
  if (weekday === -1) return null;
  const delta = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, delta === 0 ? 7 : delta);
}

function defaultIsOpen(options: ResolveOptions): (isoDate: string, part?: PartOfDay) => boolean {
  const closures = options.closureDays ?? DEFAULT_CLOSURE_DAYS;
  const location = options.locationId?.toLowerCase();
  return (isoDate, part) => {
    if (closures.includes(isoDate)) return false;
    const day = weekdayOf(isoDate);
    if (day === 0) return false;
    // Only Centro opens on a Saturday; with no site named, someone is open.
    if (day === 6 && location !== undefined && !location.includes('centro')) return false;
    // Sur shuts Friday lunchtime, so a Friday afternoon there is not bookable.
    if (day === 5 && part === 'afternoon' && location?.includes('sur')) return false;
    return true;
  };
}

function firstOpenFrom(
  start: string,
  part: PartOfDay | undefined,
  isOpen: (isoDate: string, part?: PartOfDay) => boolean,
): string | null {
  for (let i = 0; i < 14; i++) {
    const day = addDays(start, i);
    if (isOpen(day, part)) return day;
  }
  return null;
}

// --- civil date arithmetic, no timezone left in it --------------------------

/** The calendar date in Madrid at this instant, which is the only "today" that counts. */
export function madridDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
