/**
 * The one shape the UI sees. Every wire and row shape from wire.ts is normalised
 * here and only here, so the SSE-vs-REST disagreements (0/1 vs boolean, JSON text
 * vs arrays) are settled once instead of in every component.
 */
import type {
  CallDetailResponse,
  CallEnded,
  CallRecord,
  CallStarted,
  RecentCallRecord,
  SubmissionRecord,
  SubmissionRow,
  TurnRecord,
  TurnRow,
} from './wire';

export type Role = 'user' | 'assistant';

export interface Turn {
  seq: number;
  role: Role;
  text: string;
  at: string;
}

export interface Submission {
  seq: number;
  action: string;
  route: string;
  /** The JSON body exactly as POSTed to Prosper. */
  body: unknown;
  /** 200 accepted · 409 duplicate · 410 window closed · 422 malformed · 404 unknown call · 0 never sent. */
  status: number;
  response: unknown;
  attempts: number | null;
  durationMs: number | null;
  error: string | null;
}

/** What a call ended in, per action. Known from the list before its submissions are. */
export interface Outcome {
  action: string;
  status: number;
}

export interface Call {
  id: string;
  streamSid: string | null;
  fromNumber: string | null;
  startedAt: string;
  endedAt: string | null;
  endedBy: string | null;
  durationMs: number | null;
  framesIn: number | null;
  framesOut: number | null;
  timings: {
    sessionStartMs: number | null;
    deciderMs: number | null;
    /** The 30 s submission window, measured: socket close → POST accepted. */
    closeToSubmittedMs: number | null;
  };
  decider: {
    model: string | null;
    raw: string | null;
    notes: string | null;
    confidence: number | null;
    /** The decider failed and the always-submit floor answered instead. */
    usedFloor: boolean;
  };
  errors: string[];
  turnCount: number;
  turns: Turn[];
  submissions: Submission[];
  outcomes: Outcome[];
}

export type CallStatus = 'live' | 'ended' | 'stale';

/**
 * Prosper cuts every call at three minutes. A call still open well past that lost
 * its agent before it could write `call_ended`, and would otherwise read as live
 * forever.
 */
export const STALE_AFTER_MS = 3.5 * 60_000;

export function callStatus(call: Call, now: number): CallStatus {
  if (call.endedAt) return 'ended';
  return now - Date.parse(call.startedAt) > STALE_AFTER_MS ? 'stale' : 'live';
}

// --- normalisers ------------------------------------------------------------

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** "book=200,cancel=409" → [{book,200},{cancel,409}]. */
export function parseOutcome(outcome: string | null): Outcome[] {
  if (!outcome) return [];
  return outcome.split(',').flatMap((pair) => {
    const eq = pair.lastIndexOf('=');
    if (eq < 1) return [];
    return [{ action: pair.slice(0, eq), status: Number(pair.slice(eq + 1)) }];
  });
}

export function emptyCall(id: string, startedAt: string): Call {
  return {
    id,
    streamSid: null,
    fromNumber: null,
    startedAt,
    endedAt: null,
    endedBy: null,
    durationMs: null,
    framesIn: null,
    framesOut: null,
    timings: { sessionStartMs: null, deciderMs: null, closeToSubmittedMs: null },
    decider: { model: null, raw: null, notes: null, confidence: null, usedFloor: false },
    errors: [],
    turnCount: 0,
    turns: [],
    submissions: [],
    outcomes: [],
  };
}

export function fromCallRecord(r: CallRecord): Call {
  return {
    ...emptyCall(r.call_id, r.started_at),
    streamSid: r.stream_sid,
    fromNumber: r.from_number,
    endedAt: r.ended_at,
    endedBy: r.ended_by,
    durationMs: r.call_ms,
    framesIn: r.frames_in,
    framesOut: r.frames_out,
    timings: {
      sessionStartMs: r.session_start_ms,
      deciderMs: r.decider_ms,
      closeToSubmittedMs: r.close_to_submitted_ms,
    },
    decider: {
      model: r.decider_model,
      raw: r.decider_raw,
      notes: r.decider_notes,
      confidence: r.decider_conf,
      usedFloor: r.used_floor === 1,
    },
    errors: parseJson<string[]>(r.errors, []),
  };
}

export function fromRecentRecord(r: RecentCallRecord): Call {
  return { ...fromCallRecord(r), turnCount: r.turn_count, outcomes: parseOutcome(r.outcome) };
}

/** Null for an id the agent does not know — see CallDetailResponse. */
export function fromDetail(d: CallDetailResponse): Call | null {
  if (!d.call) return null;
  const turns = d.turns.map(toTurn);
  const submissions = d.submissions.map(toSubmission);
  return {
    ...fromCallRecord(d.call),
    turns,
    turnCount: turns.length,
    submissions,
    outcomes: submissions.map(toOutcome),
  };
}

export function fromCallStarted(m: CallStarted): Call {
  return {
    ...emptyCall(m.call_id, m.started_at),
    streamSid: m.stream_sid ?? null,
    fromNumber: m.from_number ?? null,
  };
}

/** The fields `call_ended` carries; everything else about the call is left alone. */
export function fromCallEnded(m: CallEnded): Pick<
  Call,
  'endedAt' | 'endedBy' | 'durationMs' | 'framesIn' | 'framesOut' | 'timings' | 'decider' | 'errors'
> {
  return {
    endedAt: m.ended_at,
    endedBy: m.ended_by,
    durationMs: m.call_ms,
    framesIn: m.frames_in,
    framesOut: m.frames_out,
    timings: {
      sessionStartMs: m.session_start_ms ?? null,
      deciderMs: m.decider_ms ?? null,
      closeToSubmittedMs: m.close_to_submitted_ms ?? null,
    },
    decider: {
      model: m.decider_model ?? null,
      raw: m.decider_raw ?? null,
      notes: m.decider_notes ?? null,
      confidence: m.decider_conf ?? null,
      usedFloor: m.used_floor,
    },
    errors: m.errors,
  };
}

export function toTurn(t: TurnRecord | TurnRow): Turn {
  return { seq: t.seq, role: t.role, text: t.text, at: t.at };
}

export function toSubmission(s: SubmissionRecord | SubmissionRow): Submission {
  return {
    seq: s.seq,
    action: s.action,
    route: s.route,
    body: parseJson<unknown>(s.body, s.body),
    status: s.status,
    response: parseJson<unknown>(s.response ?? null, s.response ?? null),
    attempts: s.attempts ?? null,
    durationMs: s.duration_ms ?? null,
    error: s.error ?? null,
  };
}

export function toOutcome(s: Submission): Outcome {
  return { action: s.action, status: s.status };
}
