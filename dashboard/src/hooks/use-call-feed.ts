import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { fetchCall, fetchRecentCalls, subscribeToFeed } from '@/lib/agent/client';
import { feedReducer, initialFeed } from '@/lib/agent/feed';
import type { Call } from '@/lib/agent/model';
import type { AgentMode } from '@/lib/agent/stats';

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
export function useCallFeed(mode?: AgentMode): CallFeed {
  const [state, dispatch] = useReducer(feedReducer, initialFeed);
  const otherModeIds = useRef(new Set<string>());

  useEffect(() => {
    const controller = new AbortController();
    otherModeIds.current.clear();

    const hydrate = async (): Promise<void> => {
      try {
        const { live, calls } = await fetchRecentCalls(HYDRATE_LIMIT, controller.signal, mode);
        dispatch({ kind: 'hydrated-list', live, calls });

        // In-flight calls need their turns so far; the stream only brings the next ones.
        await Promise.allSettled(
          calls
            .filter((c) => !c.endedAt)
            .map(async (c) => {
              const call = await fetchCall(c.id, controller.signal);
              if (call && (!mode || call.clinicMode === mode)) dispatch({ kind: 'hydrated-call', call });
            }),
        );
      } catch (err) {
        if (!controller.signal.aborted) console.warn('[feed] hydrate failed', err);
      }
    };

    const unsubscribe = subscribeToFeed({
      onEvent: (event) => {
        if (mode && 'call_id' in event) {
          if (event.type === 'call_started') {
            const eventMode = event.clinic_mode ?? 'live';
            if (eventMode !== mode) {
              otherModeIds.current.add(event.call_id);
              return;
            }
            otherModeIds.current.delete(event.call_id);
          } else if (otherModeIds.current.has(event.call_id)) {
            return;
          }
        }
        dispatch({ kind: 'event', event });
      },
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
    const call = await fetchCall(id);
    if (call && (!mode || call.clinicMode === mode)) dispatch({ kind: 'hydrated-call', call });
  }, [mode]);

  const calls = useMemo(
    () => Object.values(state.calls).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    [state.calls],
  );

  return { calls, live: state.live, connected: state.connected, loadCall };
}
