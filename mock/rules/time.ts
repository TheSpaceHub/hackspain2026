/**
 * Clinic time. Everything the API says about a moment is Europe/Madrid wall-clock
 * with an explicit offset — "2026-09-24T16:30:00+02:00" — and every date it takes
 * is a Madrid calendar date. Dates are handled as YYYY-MM-DD strings and turned into
 * instants only at the edges, so no host timezone ever leaks in.
 */

export const TZ = 'Europe/Madrid';

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const offsetFormat = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' });
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "+02:00" in summer, "+01:00" in winter. */
export function madridOffset(instant: number): string {
  const name = offsetFormat.formatToParts(instant).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  return name === 'GMT' ? '+00:00' : name.slice(3);
}

/** Madrid wall-clock → ISO with its offset. `minutes` is minutes after midnight. */
export function madridIso(date: string, minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  // The offset in force at that wall-clock time; off only inside the hour a DST switch skips.
  const offset = madridOffset(Date.parse(`${date}T${hh}:${mm}:00+02:00`));
  return `${date}T${hh}:${mm}:00${offset}`;
}

export function toInstant(iso: string): number {
  return Date.parse(iso);
}

/** The Madrid calendar date and minute-of-day of an instant. */
export function madridParts(instant: number): { date: string; minutes: number } {
  const p = Object.fromEntries(dateFormat.formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function todayMadrid(now = Date.now()): string {
  return madridParts(now).date;
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export function* eachDay(from: string, to: string): Generator<string> {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

/** "09:00–14:00" → [540, 840]. The catalogue writes ranges with an en dash. */
export function parseInterval(interval: string): [number, number] {
  const [a, b] = interval.split(/[–-]/).map((t) => {
    const [h, m] = t.trim().split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  });
  return [a ?? 0, b ?? 0];
}

/** Whole years, then whole months, on a given date — ages are compared in months. */
export function ageInMonths(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  let months = ((y ?? 0) - (by ?? 0)) * 12 + ((m ?? 0) - (bm ?? 0));
  if ((d ?? 0) < (bd ?? 0)) months -= 1;
  return months;
}

