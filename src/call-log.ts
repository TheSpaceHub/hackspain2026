import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import type { DeciderResult } from './decider.js';
import type { SubmitResult } from './submit.js';
import type { TranscriptTurn } from './transcript.js';

/**
 * One JSON line per call: the call id, the transcript, what the decider was given
 * and what it returned, every POST body and status, and the timings.
 *
 * This file is the evaluation harness. It goes in on day one rather than being
 * retrofitted, because "why did it say that?" is a question only a record can
 * answer, and the jury marks engineering rigour on exactly this.
 */

export interface CallLog {
  call_id: string;
  stream_sid?: string;
  from_number?: string;
  started_at: string;
  ended_at: string;
  timings: {
    call_ms: number;
    session_start_ms?: number;
    decider_ms?: number;
    submit_ms?: number;
    /** Time from socket close to the last POST returning — the 30 s window. */
    close_to_submitted_ms?: number;
  };
  audio: {
    frames_in: number;
    frames_out: number;
  };
  transcript: TranscriptTurn[];
  decider?: {
    input: { from_number?: string; now: string; turns: number };
    output: DeciderResult['output'];
    raw?: string;
    error?: string;
    used_floor: boolean;
  };
  submissions: SubmitResult[];
  errors: string[];
  ended_by: string;
}

let dirReady: Promise<void> | null = null;

export async function writeCallLog(entry: CallLog): Promise<void> {
  try {
    dirReady ??= mkdir(config.logDir, { recursive: true }).then(() => undefined);
    await dirReady;
    const day = entry.started_at.slice(0, 10);
    await appendFile(join(config.logDir, `calls-${day}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    // A log that cannot be written must never take a call down with it.
    console.error(`[log] failed to write call log for ${entry.call_id}: ${String(err)}`);
  }
}
