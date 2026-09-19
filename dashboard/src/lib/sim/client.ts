/**
 * The shared clinic's `/__sim` console: REST for where things stand, SSE for what
 * changes. Same-origin in dev (Vite proxies /__sim to :8788); a built bundle needs
 * VITE_SIM_ORIGIN.
 *
 * Unlike the agent's feed, the sim's log is replayable: every event carries an id
 * and `/__sim/events?since=<id>` sends the ones missed, so a reconnect picks up
 * where it left off instead of rehydrating blind.
 */
import type { DiaryDay, Hold, SimCall, SimEvent, SimEventType, SimState } from './wire';

const ORIGIN = import.meta.env.PROD ? (import.meta.env.VITE_SIM_ORIGIN ?? '') : '';

/** The port the sim listens on — what tells its URL from the mock's in the agent's /health. */
const SIM_PORT = ((): string => {
  try {
    return new URL(import.meta.env.VITE_SIM_ORIGIN ?? 'http://localhost:8788').port || '80';
  } catch {
    return '8788';
  }
})();

/** Is this clinic API URL (from the agent's /health) the shared clinic on this machine? */
export function isSimUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    return local && (u.port || '80') === SIM_PORT;
  } catch {
    return false;
  }
}

async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${ORIGIN}${path}`, { method, signal });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      /* not JSON */
    }
    throw new Error(`${method} ${path} → ${detail}`);
  }
  return (await res.json()) as T;
}

export const fetchState = (signal?: AbortSignal): Promise<SimState> => request('GET', '/__sim', signal);

export const fetchHolds = (signal?: AbortSignal): Promise<Hold[]> =>
  request<{ holds: Hold[] }>('GET', '/__sim/holds', signal).then((b) => b.holds);

export const fetchDiary = (date: string, signal?: AbortSignal): Promise<DiaryDay> =>
  request('GET', `/__sim/diary?date=${encodeURIComponent(date)}`, signal);

/** The newest events, oldest first — the ticker's backfill before the stream starts. */
export const fetchRecentEvents = (limit: number, signal?: AbortSignal): Promise<SimEvent[]> =>
  request<{ events: SimEvent[] }>('GET', `/__sim/log?limit=${limit}`, signal).then((b) => b.events);

export const fetchSimCalls = (signal?: AbortSignal): Promise<SimCall[]> =>
  request<{ calls: SimCall[] }>('GET', '/__sim/calls', signal).then((b) => b.calls);

export interface ResetResult extends SimState {
  reset: true;
  resnapshot?: true;
}

/** Back to the snapshot; `resnapshot` re-copies the live clinic first (409 when there is none). */
export const resetClinic = (resnapshot: boolean): Promise<ResetResult> =>
  request('POST', `/__sim/reset${resnapshot ? '?resnapshot=1' : ''}`);

/** Release one hold on the operator's behalf. */
export const releaseHold = (hold: Hold): Promise<unknown> =>
  request('DELETE', `/__sim/holds/${encodeURIComponent(hold.hold_id)}?call_id=${encodeURIComponent(hold.call_id)}`);

const EVENT_TYPES: readonly SimEventType[] = [
  'snapshot',
  'reset',
  'call_opened',
  'call_closed',
  'hold',
  'hold_released',
  'hold_expired',
  'hold_conflict',
  'book',
  'book_rejected',
  'reschedule',
  'reschedule_rejected',
  'cancel',
  'cancel_rejected',
  'register',
  'register_rejected',
  'no_action',
  'escalate',
];

export interface SimFeedHandlers {
  onEvent: (event: SimEvent) => void;
  /** `replayed` — the browser reconnected and the server is sending what was missed. */
  onOpen: () => void;
  onError: () => void;
}

/**
 * Subscribe to `/__sim/events`. `since` is the last id already seen (0 for none): the
 * server replays after it, then streams. The browser's own reconnect sends
 * Last-Event-ID, so nothing is lost across a dropped connection either.
 */
export function subscribeToSim(since: number, handlers: SimFeedHandlers): () => void {
  const source = new EventSource(`${ORIGIN}/__sim/events?since=${since}`);

  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (e) => {
      try {
        handlers.onEvent(JSON.parse((e as MessageEvent<string>).data) as SimEvent);
      } catch {
        /* a malformed line is dropped, the stream goes on */
      }
    });
  }
  source.addEventListener('open', handlers.onOpen);
  source.addEventListener('error', handlers.onError);

  return () => source.close();
}
