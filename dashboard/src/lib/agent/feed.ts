/**
 * The live picture of every call, as a pure reducer — no React, no network, so it
 * can be reasoned about (and tested) on its own.
 *
 * It is fed from two sources that race: REST hydration and the SSE stream. The SSE
 * has no replay, so the hook opens it *before* hydrating, and both land here in
 * whatever order they arrive. Every merge is therefore idempotent and
 * order-independent: a turn or submission is keyed by its `seq`, a known value is
 * never overwritten by an unknown one, and a late REST snapshot cannot undo what a
 * newer event already said.
 */
import {
  type Call,
  emptyCall,
  fromCallEnded,
  fromCallStarted,
  toOutcome,
  toSubmission,
  toTurn,
} from './model';
import type { FeedEvent } from './wire';

export interface FeedState {
  calls: Record<string, Call>;
  /** Sockets open on the agent right now, as the agent itself counts them. */
  live: number;
  connected: boolean;
}

export type FeedAction =
  | { kind: 'connected'; connected: boolean }
  | { kind: 'hydrated-list'; live: number; calls: Call[] }
  | { kind: 'hydrated-call'; call: Call }
  | { kind: 'event'; event: FeedEvent };

export const initialFeed: FeedState = { calls: {}, live: 0, connected: false };

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.kind) {
    case 'connected':
      return { ...state, connected: action.connected };

    case 'hydrated-list': {
      const calls = { ...state.calls };
      for (const call of action.calls) calls[call.id] = mergeCall(calls[call.id], call);
      return { ...state, calls, live: action.live };
    }

    case 'hydrated-call':
      return withCall(state, action.call.id, (prev) => mergeCall(prev, action.call));

    case 'event':
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: FeedState, e: FeedEvent): FeedState {
  switch (e.type) {
    case 'hello':
    case 'heartbeat':
      return { ...state, live: e.live };

    case 'call_started':
      return withCall(state, e.call_id, (prev) => mergeCall(prev, fromCallStarted(e)));

    case 'turn':
      // A turn can name a call we never saw start — the stream was opened mid-call.
      return withCall(state, e.call_id, (prev) =>
        mergeCall(prev, { ...emptyCall(e.call_id, e.at), turns: [toTurn(e)] }),
      );

    case 'call_ended':
      return withCall(state, e.call_id, (prev) =>
        mergeCall(prev, { ...emptyCall(e.call_id, e.ended_at), ...fromCallEnded(e) }),
      );

    case 'submission':
      return withCall(state, e.call_id, (prev) =>
        mergeCall(prev, { ...emptyCall(e.call_id, new Date().toISOString()), submissions: [toSubmission(e)] }),
      );
  }
}

function withCall(state: FeedState, id: string, update: (prev: Call | undefined) => Call): FeedState {
  return { ...state, calls: { ...state.calls, [id]: update(state.calls[id]) } };
}

// --- merging ----------------------------------------------------------------

/** The known value wins; `null` means "this source did not say", never "cleared". */
function known<T>(next: T | null, prev: T | null): T | null {
  return next ?? prev;
}

function bySeq<T extends { seq: number }>(prev: T[], next: T[]): T[] {
  if (next.length === 0) return prev;
  const merged = new Map(prev.map((x) => [x.seq, x]));
  for (const x of next) merged.set(x.seq, x);
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}

function earliest(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

export function mergeCall(prev: Call | undefined, next: Call): Call {
  if (!prev) return next;

  const turns = bySeq(prev.turns, next.turns);
  const submissions = bySeq(prev.submissions, next.submissions);

  return {
    id: prev.id,
    // A stub is stamped with whatever moment first mentioned the call; the true start
    // is always the earliest one anyone reported.
    startedAt: earliest(prev.startedAt, next.startedAt),
    streamSid: known(next.streamSid, prev.streamSid),
    fromNumber: known(next.fromNumber, prev.fromNumber),
    endedAt: known(next.endedAt, prev.endedAt),
    endedBy: known(next.endedBy, prev.endedBy),
    durationMs: known(next.durationMs, prev.durationMs),
    framesIn: known(next.framesIn, prev.framesIn),
    framesOut: known(next.framesOut, prev.framesOut),
    timings: {
      sessionStartMs: known(next.timings.sessionStartMs, prev.timings.sessionStartMs),
      deciderMs: known(next.timings.deciderMs, prev.timings.deciderMs),
      closeToSubmittedMs: known(next.timings.closeToSubmittedMs, prev.timings.closeToSubmittedMs),
    },
    decider: {
      model: known(next.decider.model, prev.decider.model),
      raw: known(next.decider.raw, prev.decider.raw),
      notes: known(next.decider.notes, prev.decider.notes),
      confidence: known(next.decider.confidence, prev.decider.confidence),
      // The floor either fired or it did not; once anyone reports it, it did.
      usedFloor: prev.decider.usedFloor || next.decider.usedFloor,
    },
    errors: next.errors.length > 0 ? next.errors : prev.errors,
    turns,
    // The list reports a count before the turns themselves are loaded.
    turnCount: Math.max(prev.turnCount, next.turnCount, turns.length),
    submissions,
    // Real submissions are the authority; the list's parsed `outcome` stands in until then.
    outcomes:
      submissions.length > 0
        ? submissions.map(toOutcome)
        : next.outcomes.length > 0
          ? next.outcomes
          : prev.outcomes,
  };
}
