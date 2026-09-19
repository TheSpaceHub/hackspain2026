/**
 * The overview's numbers, aggregated by the agent's store (GET /stats) — never
 * counted from the feed, which only holds the most recent calls.
 */

export interface Distribution {
  p50: number | null;
  p95: number | null;
  max: number | null;
  n: number;
}

export interface Stats {
  since: string | null;
  live: number;
  totals: {
    calls: number;
    ended: number;
    with_record: number;
    without_record: number;
    rejected: number;
    floor_used: number;
  };
  /** Ended calls by first accepted action; `none` for no record. */
  outcomes: Record<string, number>;
  latency: {
    call_ms: Distribution;
    session_start_ms: Distribution;
    decider_ms: Distribution;
    close_to_submitted_ms: Distribution;
  };
  bucket_ms: number;
  series: { at: string; calls: number; with_record: number; call_ms_p50: number | null }[];
}

export type RangeId = 'hour' | 'today' | 'all';

export interface Range {
  id: RangeId;
  label: string;
  /** Said after a number: "12 calls in the last hour". */
  phrase: string;
  bucketMs: number;
  since: (now: number) => string | null;
}

/** The ISO instant of midnight, Madrid time, on the day of `now`. */
function madridMidnight(now: number): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(now);
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'longOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')
      ?.value.slice(3) || '+00:00';
  return new Date(`${day}T00:00:00${offset}`).toISOString();
}

export const RANGES: Range[] = [
  { id: 'hour', label: 'Last hour', phrase: 'in the last hour', bucketMs: 5 * 60_000, since: (now) => new Date(now - 3_600_000).toISOString() },
  { id: 'today', label: 'Today', phrase: 'today', bucketMs: 30 * 60_000, since: madridMidnight },
  { id: 'all', label: 'All time', phrase: 'all time', bucketMs: 60 * 60_000, since: () => null },
];

const ORIGIN = import.meta.env.PROD ? (import.meta.env.VITE_AGENT_ORIGIN ?? '') : '';

export async function fetchStats(range: Range, now: number, signal?: AbortSignal): Promise<Stats> {
  const q = new URLSearchParams({ bucket_ms: String(range.bucketMs) });
  const since = range.since(now);
  if (since) q.set('since', since);
  const res = await fetch(`${ORIGIN}/stats?${q}`, { signal });
  if (!res.ok) throw new Error(`GET /stats → ${res.status}`);
  return (await res.json()) as Stats;
}

export interface AgentHealth {
  ok: boolean;
  live: number;
  /** The clinic API the agent reads from and submits to. */
  clinic_api?: string;
}

export async function fetchHealth(signal?: AbortSignal): Promise<AgentHealth> {
  const res = await fetch(`${ORIGIN}/health`, { signal });
  if (!res.ok) throw new Error(`GET /health → ${res.status}`);
  return (await res.json()) as AgentHealth;
}
