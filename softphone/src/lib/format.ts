/**
 * Display formatting. Clinic time is Europe/Madrid whatever the viewer's machine
 * says, so every clock and date shown is Madrid's.
 */

const TZ = 'Europe/Madrid';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const clockSeconds = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

export function formatClock(iso: string, seconds = false): string {
  return (seconds ? clockSeconds : clock).format(new Date(iso));
}

/** The Madrid calendar day of an instant, as YYYY-MM-DD — for grouping. */
export function dayKey(iso: string): string {
  return dayKeyFormat.format(new Date(iso));
}

/** "Today", "Yesterday", or "Sat 19 Sep". */
export function formatDay(iso: string, now = Date.now()): string {
  const key = dayKey(iso);
  const today = dayKeyFormat.format(new Date(now));
  const yesterday = dayKeyFormat.format(new Date(now - 86_400_000));
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return dayLabel.format(new Date(iso));
}

/** 43_000 → "0:43"; 3_725_000 → "1:02:05". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 4095 → "4.1 s"; 841 → "841 ms". */
export function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** "+34612345000" → "+34 612 34 50 00". Anything else is shown as it came. */
export function formatPhone(e164: string | null): string | null {
  if (!e164) return null;
  const m = /^\+34(\d{3})(\d{2})(\d{2})(\d{2})$/.exec(e164);
  return m ? `+34 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
