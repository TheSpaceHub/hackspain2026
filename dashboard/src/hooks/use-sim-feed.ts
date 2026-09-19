import { useCallback, useEffect, useReducer, useRef } from 'react';
import { fetchHolds, fetchRecentEvents, fetchState, resetClinic, subscribeToSim, type ResetResult } from '@/lib/sim/client';
import { initialSimFeed, simFeedReducer, type SimFeedState } from '@/lib/sim/feed';

const EVENT_BACKFILL = 200;
/** How often to knock when nothing answers on /__sim. */
const PROBE_MS = 10_000;
/** Settle a burst of events into one re-read of the counters. */
const STATE_DEBOUNCE_MS = 600;

export interface SimFeed extends SimFeedState {
  /** POST /__sim/reset — with `resnapshot`, re-copy the live clinic first. Resolves to the message to show. */
  reset: (resnapshot: boolean) => Promise<ResetResult>;
}

/**
 * The shared clinic, kept current. Probes /__sim until something answers (the sim is
 * optional — against real Prosper there is none), hydrates, then subscribes to the
 * stream from the last event seen; the server replays anything in between, and a
 * dropped connection resumes the same way via Last-Event-ID.
 */
export function useSimFeed(): SimFeed {
  const [state, dispatch] = useReducer(simFeedReducer, initialSimFeed);
  const lastId = useRef(0);
  lastId.current = state.lastId;

  useEffect(() => {
    const controller = new AbortController();
    let unsubscribe: (() => void) | null = null;
    let probe: ReturnType<typeof setTimeout> | null = null;
    let counters: ReturnType<typeof setTimeout> | null = null;

    const hydrate = async (withEvents: boolean): Promise<boolean> => {
      try {
        const [s, holds, events] = await Promise.all([
          fetchState(controller.signal),
          fetchHolds(controller.signal),
          withEvents ? fetchRecentEvents(EVENT_BACKFILL, controller.signal) : Promise.resolve(undefined),
        ]);
        dispatch({ kind: 'hydrated', state: s, holds, events });
        return true;
      } catch {
        if (!controller.signal.aborted) dispatch({ kind: 'unavailable' });
        return false;
      }
    };

    const refreshCounters = (): void => {
      if (counters) clearTimeout(counters);
      counters = setTimeout(() => {
        fetchState(controller.signal)
          .then((s) => fetchHolds(controller.signal).then((holds) => dispatch({ kind: 'hydrated', state: s, holds })))
          .catch(() => {});
      }, STATE_DEBOUNCE_MS);
    };

    const start = async (): Promise<void> => {
      if (controller.signal.aborted) return;
      if (!(await hydrate(true))) {
        probe = setTimeout(() => void start(), PROBE_MS);
        return;
      }
      if (controller.signal.aborted) return;
      unsubscribe = subscribeToSim(lastId.current, {
        onEvent: (event) => {
          dispatch({ kind: 'event', event });
          refreshCounters();
        },
        onOpen: () => {
          dispatch({ kind: 'connected', connected: true });
          // Holds may have expired while the stream was down; the replay says the rest.
          void hydrate(false);
        },
        onError: () => dispatch({ kind: 'connected', connected: false }),
      });
    };

    void start();

    return () => {
      controller.abort();
      if (probe) clearTimeout(probe);
      if (counters) clearTimeout(counters);
      unsubscribe?.();
    };
  }, []);

  const reset = useCallback(async (resnapshot: boolean): Promise<ResetResult> => {
    const result = await resetClinic(resnapshot);
    const holds = await fetchHolds();
    dispatch({ kind: 'hydrated', state: result, holds });
    return result;
  }, []);

  return { ...state, reset };
}
