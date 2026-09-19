import { useEffect, useRef, useState } from 'react';
import { fetchDiary } from '@/lib/sim/client';
import type { DiaryDay } from '@/lib/sim/wire';

/** Settle a burst — a call's hold, then its booking — into one refetch. */
const DEBOUNCE_MS = 250;

/**
 * One day of the clinic's diary, refetched when the date changes or when `version`
 * bumps (the feed does that on every hold, booking, move or cancel). The previous
 * day stays on screen while the next loads.
 */
export function useDiary(date: string, version: number, enabled: boolean): { diary: DiaryDay | null; loading: boolean; error: boolean } {
  const [diary, setDiary] = useState<DiaryDay | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      setLoading(true);
      fetchDiary(date, controller.signal)
        .then((d) => {
          setDiary(d);
          setError(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [date, version, enabled]);

  useEffect(() => () => inflight.current?.abort(), []);

  return { diary, loading, error };
}
