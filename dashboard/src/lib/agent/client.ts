/**
 * Talking to one selected agent's console API. In dev Vite proxies each prefixed
 * path to its fixed-mode agent; deployed builds use the per-mode runtime origin
 * (origin.ts), and the agent sends `Access-Control-Allow-Origin: *`.
 */
import { type Call, fromDetail, fromRecentRecord } from './model';
import { agentOrigin, type AgentMode } from './origin';
import type { CallDetailResponse, FeedEvent, RecentCallsResponse } from './wire';
export function listenUrl(mode: AgentMode, id: string): string {
  return `${agentOrigin(mode)}/calls/${encodeURIComponent(id)}/listen`;
}

export function recordingUrl(mode: AgentMode, id: string): string {
  return `${agentOrigin(mode)}/calls/${encodeURIComponent(id)}/recording.wav`;
}

async function getJson<T>(mode: AgentMode, path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${agentOrigin(mode)}${path}`, { signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchRecentCalls(
  mode: AgentMode,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ live: number; calls: Call[] }> {
  const q = new URLSearchParams({ limit: String(limit) });
  const r = await getJson<RecentCallsResponse>(mode, `/calls?${q}`, signal);
  return { live: r.live, calls: r.calls.map(fromRecentRecord) };
}

/** Null when the agent does not know the id. */
export async function fetchCall(mode: AgentMode, id: string, signal?: AbortSignal): Promise<Call | null> {
  return fromDetail(await getJson<CallDetailResponse>(mode, `/calls/${encodeURIComponent(id)}`, signal));
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
export function subscribeToFeed(mode: AgentMode, handlers: FeedHandlers): () => void {
  const source = new EventSource(`${agentOrigin(mode)}/events`);

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
