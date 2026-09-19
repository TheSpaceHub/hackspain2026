/**
 * The calls the mock knows about, and what was submitted on each.
 *
 * On the real platform a call exists because the harness dialled it; here the
 * harness says so through the control routes (routes/control.ts). The submission
 * window is the real one: open from the moment the call opens, closed 30 s after
 * the socket to the agent closes. Early is never a rejection; late always is.
 */
import type { RecordedAction } from './schemas.js';

export const WINDOW_MS = 30_000;

export interface CallState {
  call_id: string;
  opened_at: number;
  closed_at: number | null;
  /** The local case this call is playing, when the harness named one. */
  scenario: string | null;
  from_number: string | null;
  actions: RecordedAction[];
  last_received_at: number | null;
}

export type SubmitOutcome =
  | { status: 200; call: CallState; received_at: number }
  | { status: 404 | 409 | 410; detail: string };

/** Key order must not make two identical actions look different. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class Calls {
  readonly #calls = new Map<string, CallState>();

  /**
   * @param acceptAny register an unknown call_id on its first submission instead of
   *   answering 404 — for driving the agent without the harness. Off by default,
   *   because the real API is strict.
   */
  constructor(private readonly acceptAny = false) {}

  open(call_id: string, meta: { scenario?: string | null; from_number?: string | null } = {}): CallState {
    const existing = this.#calls.get(call_id);
    if (existing) return existing;
    const call: CallState = {
      call_id,
      opened_at: Date.now(),
      closed_at: null,
      scenario: meta.scenario ?? null,
      from_number: meta.from_number ?? null,
      actions: [],
      last_received_at: null,
    };
    this.#calls.set(call_id, call);
    return call;
  }

  close(call_id: string): CallState | undefined {
    const call = this.#calls.get(call_id);
    if (call && call.closed_at === null) call.closed_at = Date.now();
    return call;
  }

  get(call_id: string): CallState | undefined {
    return this.#calls.get(call_id);
  }

  list(): CallState[] {
    return [...this.#calls.values()].sort((a, b) => b.opened_at - a.opened_at);
  }

  submit(call_id: string, action: RecordedAction, now = Date.now()): SubmitOutcome {
    const call = this.#calls.get(call_id) ?? (this.acceptAny ? this.open(call_id) : undefined);
    if (!call) return { status: 404, detail: `unknown call ${call_id}` };
    // The deadline is checked before anything else.
    if (call.closed_at !== null && now - call.closed_at > WINDOW_MS) {
      return { status: 410, detail: `submission window for call ${call_id} closed at ${new Date(call.closed_at + WINDOW_MS).toISOString()}` };
    }
    const key = canonical(action);
    if (call.actions.some((a) => canonical(a) === key)) {
      return { status: 409, detail: `an identical ${action.action} was already accepted for call ${call_id}` };
    }
    call.actions.push(action);
    call.last_received_at = now;
    return { status: 200, call, received_at: now };
  }

  /** What GET /submissions returns: your most recent records, newest first. */
  records(limit: number): { call_id: string; record: { actions: RecordedAction[] }; received_at: string }[] {
    return [...this.#calls.values()]
      .filter((c) => c.last_received_at !== null)
      .sort((a, b) => b.last_received_at! - a.last_received_at!)
      .slice(0, limit)
      .map((c) => ({ call_id: c.call_id, record: { actions: c.actions }, received_at: new Date(c.last_received_at!).toISOString() }));
  }
}
