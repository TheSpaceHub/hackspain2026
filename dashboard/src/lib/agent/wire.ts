/**
 * What the agent actually sends, in its own snake_case. Two sources, two shapes
 * for the same data:
 *
 * - SSE (`/events`) emits the store *messages* verbatim — the objects
 *   CallSession hands the store, typed in the agent's src/store/protocol.ts and
 *   imported from there, so they cannot drift.
 * - REST (`/calls`, `/calls/:id`) returns SQLite *rows*, where the same fields
 *   have been through the database: booleans are 0/1 and arrays are JSON text.
 *
 * Nothing outside src/lib/agent should touch either; model.ts turns both into one.
 */
import type { CallAlerts, CallEnded, CallStarted, SubmissionRow, TurnRow } from '@agent/store/protocol';

export type { CallEnded, CallStarted, SubmissionRow, TurnRow };

/** The `calls` table, as `SELECT *` returns it. */
export interface CallRecord {
  call_id: string;
  stream_sid: string | null;
  from_number: string | null;
  started_at: string;
  ended_at: string | null;
  ended_by: string | null;
  call_ms: number | null;
  frames_in: number | null;
  frames_out: number | null;
  session_start_ms: number | null;
  decider_ms: number | null;
  close_to_submitted_ms: number | null;
  decider_model: string | null;
  decider_raw: string | null;
  decider_notes: string | null;
  decider_conf: number | null;
  /** A boolean on the wire, an integer in the table. */
  used_floor: 0 | 1;
  /** A string[] on the wire, JSON text in the table. */
  errors: string | null;
  /** JSON Alert[], derived by the store worker; null until it has run. */
  alerts: string | null;
}

/** A row of `GET /calls`: the call plus two columns the query derives. */
export interface RecentCallRecord extends CallRecord {
  turn_count: number;
  /** `group_concat` of `action=status` — "book=200", "cancel=200,book=409". Null with none. */
  outcome: string | null;
}

export interface TurnRecord {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  /** When the turn was flushed to the store, not when it was spoken — a flush shares one. */
  at: string;
}

/** The `submissions` table. `body` and `response` are JSON text in both sources. */
export interface SubmissionRecord {
  id: number;
  call_id: string;
  seq: number;
  action: string;
  route: string;
  body: string;
  status: number;
  response: string | null;
  attempts: number | null;
  duration_ms: number | null;
  error: string | null;
}

export interface RecentCallsResponse {
  live: number;
  calls: RecentCallRecord[];
}

/**
 * `GET /calls/:id`. `call` is absent for an unknown id: the worker answers with an
 * object whose `call` is undefined, which is truthy, so the route replies 200 rather
 * than 404 — a missing `call` is the only not-found signal.
 */
export interface CallDetailResponse {
  call?: CallRecord;
  turns: TurnRecord[];
  submissions: SubmissionRecord[];
}

/**
 * Every SSE event. Row events carry their own `type`; `hello` and `heartbeat` do
 * not, so events.ts stamps it from the `event:` name.
 */
export type FeedEvent =
  | { type: 'hello'; live: number }
  | { type: 'heartbeat'; live: number; at: number }
  | CallStarted
  | TurnRow
  | CallEnded
  | SubmissionRow
  | CallAlerts;
