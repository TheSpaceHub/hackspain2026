/**
 * What a call ended in, as a label and a tone — the one place that decides how an
 * outcome reads, so the list, the header and the transcript never disagree.
 */
import type { Call, CallStatus, Outcome } from './agent/model';

/** Named after the badge variants that render them: grey, or red when the call failed. */
export type Tone = 'secondary' | 'destructive';

const ACTIONS: Record<string, { label: string; tone: Tone }> = {
  book: { label: 'Booked', tone: 'secondary' },
  register: { label: 'Registered', tone: 'secondary' },
  reschedule: { label: 'Rescheduled', tone: 'secondary' },
  cancel: { label: 'Cancelled', tone: 'secondary' },
  no_action: { label: 'No action', tone: 'secondary' },
  escalate: { label: 'Escalated', tone: 'secondary' },
};

/** 200 accepted; 409 is a retry landing twice — still on the record. */
export function isAccepted(status: number): boolean {
  return status === 200 || status === 409;
}

export function actionLabel(action: string): string {
  return ACTIONS[action]?.label ?? action.replace(/_/g, ' ');
}

export function actionTone(action: string): Tone {
  return ACTIONS[action]?.tone ?? 'secondary';
}

export interface OutcomeSummary {
  label: string;
  tone: Tone;
  /** Further actions on the same call, beyond the first. */
  more: number;
}

export function summariseOutcome(call: Call, status: CallStatus): OutcomeSummary {
  if (status === 'stale') return { label: 'Lost', tone: 'destructive', more: 0 };
  const accepted = call.outcomes.filter((o: Outcome) => isAccepted(o.status));
  const first = accepted[0];
  // Nothing on record scores the same as a crash: always wrong, so it reads as one.
  if (!first) {
    return call.outcomes.length > 0
      ? { label: 'Rejected', tone: 'destructive', more: 0 }
      : { label: 'No record', tone: 'destructive', more: 0 };
  }
  return { label: actionLabel(first.action), tone: actionTone(first.action), more: accepted.length - 1 };
}
