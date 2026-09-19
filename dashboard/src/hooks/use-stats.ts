import { useEffect, useMemo, useRef, useState } from 'react';
import type { Call } from '@/lib/agent/model';
import { fetchStats, type Range, type Stats } from '@/lib/agent/stats';

/** A sliding window keeps sliding even when no call ends. */
const REFRESH_MS = 30_000;
/** Settle a burst — ten calls ending together — into one refetch. */
const DEBOUNCE_MS = 800;

/**
 * The overview's aggregates for a range. Refetched when the range changes, when a
 * call ends or submits (so the numbers move as the wall does), and on a slow timer.
 * The previous numbers stay on screen while the next ones load.
 */
export function useStats(
  range: Range,
  calls: Call[],
): { stats: Stats | null; updatedAt: number | null; refreshing: boolean; error: boolean; stale: boolean } {
  const [stats, setStats] = useState<Stats | null>(null);
  /** Which range the numbers on screen belong to — a new range dims them until it lands. */
  const [loadedFor, setLoadedFor] = useState<Range['id'] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  // Changes only on the events that move an aggregate — not on every spoken line.
  const signal = useMemo(
    () => `${calls.filter((c) => c.endedAt).length}:${calls.reduce((n, c) => n + c.outcomes.length, 0)}`,
    [calls],
  );

  useEffect(() => {
    const load = (): void => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      setRefreshing(true);
      fetchStats(range, Date.now(), controller.signal)
        .then((s) => {
          setStats(s);
          setLoadedFor(range.id);
          setUpdatedAt(Date.now());
          setError(false);
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) {
            console.warn('[stats]', err);
            setError(true);
          }
        })
        .finally(() => {
          if (inflight.current === controller) setRefreshing(false);
        });
    };
    const debounce = setTimeout(load, DEBOUNCE_MS);
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(debounce);
      clearInterval(timer);
    };
  }, [range, signal]);

  useEffect(() => () => inflight.current?.abort(), []);

  return { stats, updatedAt, refreshing, error, stale: stats !== null && loadedFor !== range.id };
}
