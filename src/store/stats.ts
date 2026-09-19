/**
 * Aggregates for the console's overview, computed from one row per call. Pure, so
 * the worker only runs the query and this decides what the numbers mean.
 */

/** One call as the stats query reads it. */
export interface StatsRow {
  started_at: string;
  ended_at: string | null;
  call_ms: number | null;
  session_start_ms: number | null;
  decider_ms: number | null;
  close_to_submitted_ms: number | null;
  used_floor: number;
  /** The first accepted (200/409) action on the call, or null when nothing was accepted. */
  outcome: string | null;
  /** Every submission attempted, accepted or not. */
  submissions: number;
}

export interface Distribution {
  p50: number | null;
  p95: number | null;
  max: number | null;
  n: number;
}

export interface Stats {
  since: string | null;
  totals: {
    calls: number;
    ended: number;
    /** Ended with at least one accepted submission — the only calls that can score. */
    with_record: number;
    /** Ended with nothing accepted: nothing sent, or every attempt refused. Always a failed case. */
    without_record: number;
    /** Submitted, but every attempt refused (404/410/422…). A subset of without_record. */
    rejected: number;
    /** The decider failed and the always-submit floor answered. */
    floor_used: number;
  };
  /** Ended calls by the first accepted action; `none` for no record. */
  outcomes: Record<string, number>;
  latency: {
    call_ms: Distribution;
    session_start_ms: Distribution;
    decider_ms: Distribution;
    close_to_submitted_ms: Distribution;
  };
  bucket_ms: number;
  /** Calls started per bucket, oldest first, from `since` (or the first call) to now. */
  series: { at: string; calls: number; with_record: number; call_ms_p50: number | null }[];
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

function distribution(values: (number | null)[]): Distribution {
  const v = values.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  return { p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: v.length ? v[v.length - 1]! : null, n: v.length };
}

/** At most this many buckets, whatever the range — a series, not a histogram. */
const MAX_BUCKETS = 60;

export function computeStats(rows: StatsRow[], since: string | null, bucketMs: number, now: number): Stats {
  const ended = rows.filter((r) => r.ended_at !== null);
  const withRecord = ended.filter((r) => r.outcome !== null);

  const outcomes: Record<string, number> = {};
  for (const r of ended) {
    const key = r.outcome ?? 'none';
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }

  // The series starts where the range does, or at the first call for "all time",
  // and the bucket widens until it fits.
  const from = since ? Date.parse(since) : rows.length ? Date.parse(rows[0]!.started_at) : now;
  let width = Math.max(60_000, bucketMs);
  while ((now - from) / width > MAX_BUCKETS) width *= 2;
  const start = Math.floor(from / width) * width;
  const count = Math.max(1, Math.ceil((now - start) / width));
  const series = Array.from({ length: count }, (_, i) => ({
    at: new Date(start + i * width).toISOString(),
    calls: 0,
    with_record: 0,
    call_ms_p50: null as number | null,
  }));
  const lengths = series.map((): number[] => []);
  for (const r of rows) {
    const i = Math.floor((Date.parse(r.started_at) - start) / width);
    const b = series[i];
    if (!b) continue;
    b.calls++;
    if (r.ended_at !== null && r.outcome !== null) b.with_record++;
    if (r.call_ms !== null) lengths[i]!.push(r.call_ms);
  }
  series.forEach((b, i) => {
    b.call_ms_p50 = quantile(lengths[i]!.sort((x, y) => x - y), 0.5);
  });

  return {
    since,
    totals: {
      calls: rows.length,
      ended: ended.length,
      with_record: withRecord.length,
      without_record: ended.length - withRecord.length,
      rejected: ended.filter((r) => r.outcome === null && r.submissions > 0).length,
      floor_used: ended.filter((r) => r.used_floor === 1).length,
    },
    outcomes,
    latency: {
      call_ms: distribution(ended.map((r) => r.call_ms)),
      session_start_ms: distribution(ended.map((r) => r.session_start_ms)),
      decider_ms: distribution(ended.map((r) => r.decider_ms)),
      close_to_submitted_ms: distribution(ended.map((r) => r.close_to_submitted_ms)),
    },
    bucket_ms: width,
    series,
  };
}
