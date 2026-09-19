/**
 * Talking to the agent's console API. In dev every path is same-origin and Vite
 * proxies it to the agent (vite.config.ts); set VITE_AGENT_ORIGIN to point a built
 * dashboard straight at one — the agent sends `Access-Control-Allow-Origin: *`.
 */
import { type Call, fromDetail, fromRecentRecord } from './model';
import type { CallDetailResponse, FeedEvent, RecentCallsResponse } from './wire';

const ORIGIN = import.meta.env.PROD ? (import.meta.env.VITE_AGENT_ORIGIN ?? '') : '';

export function listenUrl(id: string): string {
  return `${ORIGIN}/calls/${encodeURIComponent(id)}/listen`;
}

export function recordingUrl(id: string): string {
  return `${ORIGIN}/calls/${encodeURIComponent(id)}/recording.wav`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${ORIGIN}${path}`, { signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchRecentCalls(
  limit = 50,
  signal?: AbortSignal,
): Promise<{ live: number; calls: Call[] }> {
  const r = await getJson<RecentCallsResponse>(`/calls?limit=${limit}`, signal);
  return { live: r.live, calls: r.calls.map(fromRecentRecord) };
}

/** Null when the agent does not know the id. */
export async function fetchCall(id: string, signal?: AbortSignal): Promise<Call | null> {
  return fromDetail(await getJson<CallDetailResponse>(`/calls/${encodeURIComponent(id)}`, signal));
}

// --- the live stream --------------------------------------------------------

const ROW_EVENTS = ['call_started', 'turn', 'call_ended', 'submission', 'call_alerts'] as const;

export interface FeedHandlers {
  onEvent: (event: FeedEvent) => void;
  /** Fires on every (re)connect. The stream has no replay, so this is the cue to re-hydrate. */
  onOpen: () => void;
  onError: () => void;
}

/**
 * Subscribes to `/events`. EventSource reconnects by itself; whatever was written
 * while it was down is lost, which is why `onOpen` fires again on each reconnect.
 * Returns the unsubscribe.
 */
export function subscribeToFeed(handlers: FeedHandlers): () => void {
  const source = new EventSource(`${ORIGIN}/events`);

  const parse = (type: string, data: string): FeedEvent | null => {
    try {
      // Row events already carry `type`; hello/heartbeat do not, so stamp it from the name.
      return { type, ...JSON.parse(data) } as FeedEvent;
    } catch {
      return null;
    }
  };

  const listen = (type: string): void => {
    source.addEventListener(type, (e) => {
      const event = parse(type, (e as MessageEvent<string>).data);
      if (event) handlers.onEvent(event);
    });
  };

  listen('hello');
  listen('heartbeat');
  for (const type of ROW_EVENTS) listen(type);

  source.addEventListener('open', handlers.onOpen);
  source.addEventListener('error', handlers.onError);

  return () => source.close();
}
