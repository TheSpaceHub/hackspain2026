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
  after_clock?: { hour: number; minute: number; ambiguous: boolean };
  before_clock?: { hour: number; minute: number; ambiguous: boolean };
  at_clock?: { hour: number; minute: number; ambiguous: boolean };
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

// Half the callers say it in Spanish, and a weekday the parser does not know falls
// through to "the earliest" — which is how a Thursday caller is offered Monday.
const WEEKDAYS = [
  ['sunday', 'domingo'],
  ['monday', 'lunes'],
  ['tuesday', 'martes'],
  ['wednesday', 'mi[eé]rcoles'],
  ['thursday', 'jueves'],
  ['friday', 'viernes'],
  ['saturday', 's[aá]bado'],
];
const MONTHS = [
  ['january', 'enero'], ['february', 'febrero'], ['march', 'marzo'], ['april', 'abril'],
  ['may', 'mayo'], ['june', 'junio'], ['july', 'julio'], ['august', 'agosto'],
  ['september', 'septiembre|setiembre'], ['october', 'octubre'], ['november', 'noviembre'],
  ['december', 'diciembre'],
];

function mentions(text: string, words: string[]): boolean {
  return words.some((word) => new RegExp(`\\b(?:${word})\\b`).test(text));
}

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
  const clocks = clocksIn(text);
  const afterClock = /\b(?:after|from|no earlier than|not before)\b/.test(text) ? clocks[0] : undefined;
  const beforeClock = /\b(?:before|by|no later than)\b/.test(text) ? clocks[0] : undefined;
  const atClock = afterClock || beforeClock ? undefined : clocks[0];
  const part = partOfDay(text, afterClock, beforeClock, atClock);
  const isOpen = options.isOpen ?? defaultIsOpen(options);

  const named = namedDate(text, today) ?? relativeDate(text, today) ?? weekdayDate(text, today);
  const afterDateMarker = /\b(?:after|from|a partir del|a partir de)\b/.test(text) &&
    !/\b(?:day after tomorrow|a week from today|in a week|two weeks from today)\b/.test(text);
  const afterDate = !afterClock && afterDateMarker && named
    ? addDays(named, 1)
    : null;

  // Nothing is booked same-day: the earliest is the day after the call.
  const earliestDay = addDays(today, 1);

  if (afterDate) {
    const from = firstOpenFrom(afterDate, part, isOpen) ?? afterDate;
    return {
      date_from: from,
      date_to: addDays(from, maxSpan - 1),
      part_of_day: part,
      after_clock: afterClock,
      before_clock: beforeClock,
      at_clock: atClock,
      earliest: true,
    };
  }

  if (!named) {
    const from = firstOpenFrom(earliestDay, part, isOpen) ?? earliestDay;
    return {
      date_from: from,
      date_to: addDays(from, maxSpan - 1),
      part_of_day: part,
      after_clock: afterClock,
      before_clock: beforeClock,
      at_clock: atClock,
      earliest: true,
    };
  }

  const wanted = named < earliestDay ? earliestDay : named;
  const open = firstOpenFrom(wanted, part, isOpen) ?? wanted;
  return {
    date_from: open,
    date_to: open,
    part_of_day: part,
    after_clock: afterClock,
    before_clock: beforeClock,
    at_clock: atClock,
    adjusted_from: open === wanted ? undefined : wanted,
    earliest: false,
  };
}

/** "morning" is before 14:00 and "afternoon" from 14:00; "first thing" is the morning. */
function partOfDay(
  text: string,
  afterClock?: { hour: number; minute: number; ambiguous: boolean },
  beforeClock?: { hour: number; minute: number; ambiguous: boolean },
  atClock?: { hour: number; minute: number; ambiguous: boolean },
): PartOfDay | undefined {
  const effective = (clock: { hour: number; minute: number; ambiguous: boolean }): number => {
    const minutes = clock.hour * 60 + clock.minute;
    return clock.ambiguous && clock.hour < 8 ? minutes + 12 * 60 : minutes;
  };
  if (afterClock && effective(afterClock) >= 14 * 60) return 'afternoon';
  if (beforeClock && effective(beforeClock) <= 14 * 60) return 'morning';
  if (atClock && effective(atClock) >= 14 * 60) return 'afternoon';
  if (/\b(morning|first thing|ma(ñ|n)ana temprano|por la ma(ñ|n)ana)\b/.test(text)) return 'morning';
  if (/\b(afternoon|evening|por la tarde|la tarde|por la noche)\b/.test(text)) return 'afternoon';
  return undefined;
}

const CLOCK_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
};

function clocksIn(text: string): { hour: number; minute: number; ambiguous: boolean }[] {
  const clocks: { hour: number; minute: number; ambiguous: boolean }[] = [];
  const add = (hour: number, minute: number, meridiem?: string, context = text): void => {
    const hasPartOfDay = /\b(?:morning|afternoon|evening|night|de la ma[ñn]ana|de la tarde|por la tarde|por la noche|tarde|noche)\b/i.test(context);
    const ambiguous = !meridiem && !hasPartOfDay && hour <= 12;
    if (meridiem?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (meridiem?.toLowerCase() === 'am' && hour === 12) hour = 0;
    if (!meridiem && hour <= 12 && /\b(?:afternoon|evening|de la tarde|por la tarde|noche)\b/.test(context) && hour < 12) hour += 12;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) clocks.push({ hour, minute, ambiguous });
  };
  for (const match of text.matchAll(/\b(\d{1,2})(?:\s*[:.]\s*|\s+)(\d{2})\s*(am|pm)?\b/gi)) {
    add(Number(match[1]), Number(match[2]), match[3], text.slice(Math.max(0, match.index ?? 0) - 20, (match.index ?? 0) + match[0].length + 20));
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s*(am|pm)\b/gi)) add(Number(match[1]), 0, match[2]);
  for (const match of text.matchAll(/\b(?:after|from|before|by|at|no earlier than|not before|no later than)\s+(\d{1,2})\b(?!\s*(?:am|pm|st|nd|rd|th|of|september|october|november|december|january|february|march|april|may|june|july|august))\b/gi)) {
    add(Number(match[1]), 0, undefined, text.slice(Math.max(0, match.index ?? 0) - 20, (match.index ?? 0) + match[0].length + 20));
  }
  const words = Object.keys(CLOCK_WORDS).join('|');
  const wordClock = new RegExp(`\\b(?:half past\\s+|a las\\s+|a la\\s+)?(${words})(?:\\s+(?:in the|de la)\\s+(?:afternoon|evening|tarde|noche))?\\b`, 'gi');
  for (const match of text.matchAll(wordClock)) {
    const before = text.slice(Math.max(0, match.index ?? 0) - 12, match.index ?? 0);
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 50);
    const halfPast = /\bhalf past\b/i.test(before) || /^half past\b/i.test(match[0]!);
    add(CLOCK_WORDS[match[1]!.toLowerCase()]!, halfPast ? 30 : 0, undefined, `${before} ${match[0]} ${after}`);
  }
  return clocks;
}

/** "Monday the twelfth of October", "12 October", "the 3rd of November". */
function namedDate(rawText: string, today: string): string | null {
  // "first thing on Monday the twelfth" carries an ordinal that is not the day.
  const text = rawText.replace(/first thing/g, '');
  const month = MONTHS.findIndex((names) => mentions(text, names));
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

function relativeDate(rawText: string, today: string): string | null {
  // "el jueves por la mañana" is Thursday morning, not tomorrow: the part of day is
  // read off first, and what is left of the word no longer names a day.
  const text = rawText.replace(/\b(por|de|esta) la ma(ñ|n)ana\b/g, '');
  if (/\b(day after tomorrow|pasado ma(ñ|n)ana)\b/.test(text)) return addDays(today, 2);
  if (/\b(tomorrow|ma(ñ|n)ana)\b/.test(text)) return addDays(today, 1);
  if (/\b(a week from today|in a week|next week today|en una semana|dentro de una semana)\b/.test(text)) return addDays(today, 7);
  if (/\b(in a fortnight|two weeks from today|en dos semanas|en quince d(í|i)as)\b/.test(text)) return addDays(today, 14);
  if (/\b(today|hoy)\b/.test(text)) return addDays(today, 1); // never same-day
  return null;
}

/** A weekday phrase means the first such weekday *strictly after* the day of the call. */
function weekdayDate(text: string, today: string): string | null {
  const weekday = WEEKDAYS.findIndex((names) => mentions(text, names));
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
