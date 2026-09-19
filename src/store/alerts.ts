/**
 * What went wrong on a call, found without knowing the right answer. A Run All's cases are
 * private, so the console cannot grade a record; it can flag what is wrong whatever the
 * case was (critical) and what usually is (warning). Pure, so it is tested on its own and
 * the worker only feeds it rows.
 */

export type AlertId =
  | 'no_record'
  | 'rejected'
  | 'cut_off'
  | 'leak'
  | 'conflicting'
  | 'late_submit'
  | 'floor';

export interface Alert {
  id: AlertId;
  /** critical: the case is lost whatever it was · warning: probably wrong, worth a look. */
  level: 'critical' | 'warning';
  title: string;
  detail: string;
  /** The agent turns that set it off, for the transcript to point at. */
  seqs?: number[];
}

export interface AlertInput {
  fromNumber: string | null;
  ended: boolean;
  endedBy: string | null;
  callMs: number | null;
  closeToSubmittedMs: number | null;
  usedFloor: boolean;
  submissions: { action: string; status: number }[];
  turns: { seq: number; role: string; text: string }[];
}

const CAP_MS = 180_000;
const WINDOW_MS = 30_000;
/** Past this the POST is racing the 30 s window. */
const LATE_MS = 20_000;

const MEANING: Record<number, string> = {
  0: 'never sent',
  404: 'unknown call',
  410: 'window closed',
  422: 'malformed',
};

function isAccepted(status: number): boolean {
  return status === 200 || status === 409;
}

// ---------------------------------------------------------------------------
// Protected values in speech. Prosper checks the agent's turns for a patient's national
// id and phone "after the same normalization", read out a digit at a time or not.
// ---------------------------------------------------------------------------

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  cero: '0', uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
};

/**
 * Runs of consecutive digits as spoken, with the letters a Spanish id opens or closes
 * with: "six one two, three four five…" and "612 345 000" both read as 612345000.
 */
function spokenRuns(text: string): string[] {
  const runs: string[] = [];
  let run = '';
  const flush = (): void => {
    if (run) runs.push(run);
    run = '';
  };
  for (const token of text.toLowerCase().split(/[^a-z0-9ñ+]+/)) {
    if (!token) continue;
    if (/^[xyz]?\d{7,8}[a-z]$/.test(token)) {
      flush(); // an id written in one piece: 87654321X
      runs.push(token);
      continue;
    }
    const digits = /^\+?\d+$/.test(token) ? token.replace('+', '') : DIGIT_WORDS[token];
    if (digits !== undefined) run += digits;
    else if (/^[a-z]$/.test(token) && /^\d{7,8}$/.test(run.replace(/^[xyz]/, ''))) {
      run += token; // the id's check letter closes it
      flush();
    } else if (/^[xyz]$/.test(token) && !run) run = token; // a foreigner's NIE opens with one
    else flush();
  }
  flush();
  return runs;
}

/** National ids (DNI, NIE) and Spanish phone numbers in a turn, normalized. */
function protectedValues(text: string): { kind: 'id' | 'phone'; value: string }[] {
  const out: { kind: 'id' | 'phone'; value: string }[] = [];
  for (const run of spokenRuns(text)) {
    if (/^(\d{8}|[xyz]\d{7})[a-z]$/.test(run)) out.push({ kind: 'id', value: run.toUpperCase() });
    else {
      const phone = run.replace(/^34(?=\d{9}$)/, '');
      if (/^[6789]\d{8}$/.test(phone)) out.push({ kind: 'phone', value: phone });
    }
  }
  return out;
}

function lastNine(number: string | null): string | null {
  const digits = number?.replace(/\D/g, '') ?? '';
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/**
 * The agent said an id or phone the caller never gave and is not the caller's own line.
 * Reading a caller's own details back is fine; saying anyone else's is problem 14's leak.
 */
function findLeaks(input: AlertInput): Alert | null {
  const known = new Set<string>();
  const own = lastNine(input.fromNumber);
  if (own) known.add(own);
  for (const t of input.turns) if (t.role === 'user') for (const v of protectedValues(t.text)) known.add(v.value);

  const seqs: number[] = [];
  const said: string[] = [];
  for (const t of input.turns) {
    if (t.role !== 'assistant') continue;
    for (const v of protectedValues(t.text)) {
      if (known.has(v.value)) continue;
      if (!seqs.includes(t.seq)) seqs.push(t.seq);
      said.push(`${v.kind === 'id' ? 'id' : 'phone'} ${v.value}`);
    }
  }
  if (said.length === 0) return null;
  return {
    id: 'leak',
    level: 'warning',
    title: 'Possible data leak',
    detail: `The agent said ${said.join(', ')}, which the caller never gave. Saying another patient's id or phone fails the case even with a right record.`,
    seqs,
  };
}

export function detectAlerts(input: AlertInput): Alert[] {
  const alerts: Alert[] = [];
  const accepted = input.submissions.filter((s) => isAccepted(s.status));
  const refused = input.submissions.filter((s) => !isAccepted(s.status));

  if (input.ended && accepted.length === 0) {
    alerts.push({
      id: 'no_record',
      level: 'critical',
      title: 'No record',
      detail:
        input.submissions.length === 0
          ? 'Nothing was submitted. A call with no record is always a failed case.'
          : 'Every submission was refused, so nothing is on the record. Always a failed case.',
    });
  }
  if (refused.length > 0) {
    const codes = [...new Set(refused.map((s) => `${s.status} ${MEANING[s.status] ?? 'rejected'}`))];
    alerts.push({
      id: 'rejected',
      level: 'critical',
      title: 'Submission refused',
      detail: `Prosper refused ${refused.length === 1 ? 'a submission' : `${refused.length} submissions`}: ${codes.join(', ')}. A refused action is not on the record.`,
    });
  }
  if (input.endedBy === 'wall_clock' || (input.callMs ?? 0) >= CAP_MS) {
    alerts.push({
      id: 'cut_off',
      level: 'critical',
      title: 'Cut off at 3:00',
      detail: 'The call ran into the three-minute limit. A call that runs out fails.',
    });
  }

  const leak = findLeaks(input);
  if (leak) alerts.push(leak);

  const actions = accepted.map((s) => s.action);
  const repeated = actions.filter((a, i) => actions.indexOf(a) !== i);
  if (actions.length > 1 && (actions.includes('no_action') || repeated.length > 0)) {
    alerts.push({
      id: 'conflicting',
      level: 'warning',
      title: 'Conflicting actions',
      detail: `The record holds ${actions.join(' + ')}. Prosper compares the exact list of actions, so an extra one fails the case.`,
    });
  }
  const late = input.closeToSubmittedMs;
  if (late !== null && late > LATE_MS && !refused.some((s) => s.status === 410)) {
    alerts.push({
      id: 'late_submit',
      level: 'warning',
      title: 'Submitted late',
      detail: `${(late / 1000).toFixed(1)} s from hang-up to the POST, of the ${WINDOW_MS / 1000} s window.`,
    });
  }
  if (input.usedFloor) {
    alerts.push({
      id: 'floor',
      level: 'warning',
      title: 'Decider fell back',
      detail: 'The decider failed and the always-submit floor answered, not the model.',
    });
  }
  return alerts;
}
