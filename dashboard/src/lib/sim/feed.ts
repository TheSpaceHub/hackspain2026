/**
 * The clinic console's state and the two ways it changes: a REST hydrate and a line
 * from the event stream. Pure, so the hook stays a thin subscription.
 */
import { applyHoldEvent, DIARY_EVENTS } from './model';
import type { Hold, SimEvent, SimState } from './wire';

/** Lines kept for the ticker. */
const EVENT_CAP = 300;

export interface SimFeedState {
  /** null until the first probe answers: is a sim on the other end of /__sim at all? */
  available: boolean | null;
  /** The event stream is open. */
  connected: boolean;
  state: SimState | null;
  holds: Hold[];
  /** Oldest first, capped. */
  events: SimEvent[];
  /** Highest event id seen — where the stream resumes from. */
  lastId: number;
  /** Bumps on every event that changes a diary cell; the diary refetches on it. */
  diaryVersion: number;
}

export const initialSimFeed: SimFeedState = {
  available: null,
  connected: false,
  state: null,
  holds: [],
  events: [],
  lastId: 0,
  diaryVersion: 0,
};

export type SimFeedAction =
  | { kind: 'unavailable' }
  | { kind: 'hydrated'; state: SimState; holds: Hold[]; events?: SimEvent[] }
  | { kind: 'connected'; connected: boolean }
  | { kind: 'event'; event: SimEvent };

export function simFeedReducer(s: SimFeedState, a: SimFeedAction): SimFeedState {
  switch (a.kind) {
    case 'unavailable':
      return { ...s, available: false, connected: false };
    case 'hydrated': {
      const events = a.events ? mergeEvents(s.events, a.events) : s.events;
      return {
        ...s,
        available: true,
        state: a.state,
        holds: a.holds,
        events,
        lastId: events.length ? events[events.length - 1]!.id : s.lastId,
        diaryVersion: s.diaryVersion + 1,
      };
    }
    case 'connected':
      return s.connected === a.connected ? s : { ...s, connected: a.connected };
    case 'event': {
      if (a.event.id <= s.lastId && s.events.some((e) => e.id === a.event.id)) return s;
      const events = mergeEvents(s.events, [a.event]);
      return {
        ...s,
        events,
        lastId: Math.max(s.lastId, a.event.id),
        holds: applyHoldEvent(s.holds, a.event),
        diaryVersion: DIARY_EVENTS.has(a.event.type) ? s.diaryVersion + 1 : s.diaryVersion,
      };
    }
  }
}

/** Union by id, ascending, newest `EVENT_CAP` kept. */
function mergeEvents(have: SimEvent[], more: SimEvent[]): SimEvent[] {
  const byId = new Map<number, SimEvent>();
  for (const e of have) byId.set(e.id, e);
  for (const e of more) byId.set(e.id, e);
  const all = [...byId.values()].sort((x, y) => x.id - y.id);
  return all.length > EVENT_CAP ? all.slice(all.length - EVENT_CAP) : all;
}
