import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { fetchCall, fetchRecentCalls, subscribeToFeed } from '@/lib/agent/client';
import { feedReducer, initialFeed } from '@/lib/agent/feed';
import type { Call } from '@/lib/agent/model';
import type { AgentMode } from '@/lib/agent/origin';

const HYDRATE_LIMIT = 50;

export interface CallFeed {
  /** Newest first. */
  calls: Call[];
  /** Sockets open on the agent right now. */
  live: number;
  connected: boolean;
  /** Pull one call's full transcript and submissions — the list carries only counts. */
  loadCall: (id: string) => Promise<void>;
}

/**
 * Every call the agent knows about, kept current. Subscribes first and hydrates on
 * each (re)connect, so nothing written between the two is missed; feed.ts makes the
 * overlap harmless.
 */
export function useCallFeed(mode: AgentMode): CallFeed {
  const [state, dispatch] = useReducer(feedReducer, initialFeed);

  useEffect(() => {
    const controller = new AbortController();

    const hydrate = async (): Promise<void> => {
      try {
        const { live, calls } = await fetchRecentCalls(mode, HYDRATE_LIMIT, controller.signal);
        dispatch({ kind: 'hydrated-list', live, calls });

        // In-flight calls need their turns so far; the stream only brings the next ones.
        await Promise.allSettled(
          calls
            .filter((c) => !c.endedAt)
            .map(async (c) => {
              const call = await fetchCall(mode, c.id, controller.signal);
              if (call) dispatch({ kind: 'hydrated-call', call });
            }),
        );
      } catch (err) {
        if (!controller.signal.aborted) console.warn('[feed] hydrate failed', err);
      }
    };

    const unsubscribe = subscribeToFeed(mode, {
      onEvent: (event) => dispatch({ kind: 'event', event }),
      onOpen: () => {
        dispatch({ kind: 'connected', connected: true });
        void hydrate();
      },
      onError: () => dispatch({ kind: 'connected', connected: false }),
    });

    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [mode]);

  const loadCall = useCallback(async (id: string) => {
    const call = await fetchCall(mode, id);
    if (call) dispatch({ kind: 'hydrated-call', call });
  }, [mode]);

  const calls = useMemo(
    () => Object.values(state.calls).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    [state.calls],
  );

  return { calls, live: state.live, connected: state.connected, loadCall };
}
