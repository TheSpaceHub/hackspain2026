/**
 * What the live wall shows and how a call in flight is measured. Kept apart from the
 * components so the card and the panel read the same clock the same way.
 */
import { type Call, callStatus } from './agent/model';

/** Prosper cuts every call at three minutes; an agent that has not booked by then has failed. */
export const CALL_CAP_MS = 3 * 60_000;

/** How long an ended call stays on the wall — long enough to watch its outcome land. */
export const LINGER_MS = 20_000;

export type WallState = 'live' | 'ended';

/** Live calls, plus the ones that ended within the last few seconds; null for neither. */
export function wallState(call: Call, now: number): WallState | null {
  const status = callStatus(call, now);
  if (status === 'live') return 'live';
  if (status === 'ended' && call.endedAt && now - Date.parse(call.endedAt) < LINGER_MS) return 'ended';
  return null;
}

/** Time on the line: ticking while live, fixed at the recorded length once it ends. */
export function elapsedMs(call: Call, now: number): number {
  if (call.durationMs !== null) return call.durationMs;
  return Math.max(0, now - Date.parse(call.startedAt));
}

/** 0–1 of the way to the three-minute cut. */
export function capProgress(call: Call, now: number): number {
  return Math.min(1, elapsedMs(call, now) / CALL_CAP_MS);
}
