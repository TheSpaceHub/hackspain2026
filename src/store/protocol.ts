/** Messages between a CallSession and the store worker. Structured-cloned, so keep them small. */

import type { Alert } from './alerts.js';

export type ClinicMode = 'live' | 'simulation';

export interface CallStarted {
  type: 'call_started';
  call_id: string;
  stream_sid?: string;
  from_number?: string;
  started_at: string;
  clinic_mode: ClinicMode;
}

export interface TurnRow {
  type: 'turn';
  call_id: string;
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface CallEnded {
  type: 'call_ended';
  call_id: string;
  ended_at: string;
  ended_by: string;
  call_ms: number;
  frames_in: number;
  frames_out: number;
  session_start_ms?: number;
  decider_ms?: number;
  close_to_submitted_ms?: number;
  decider_model?: string;
  decider_raw?: string;
  decider_notes?: string;
  decider_conf?: number;
  recording_path?: string;
  recording_ms?: number;
  used_floor: boolean;
  errors: string[];
}

export interface SubmissionRow {
  type: 'submission';
  call_id: string;
  seq: number;
  action: string;
  route: string;
  body: string;
  status: number;
  response?: string;
  attempts: number;
  duration_ms: number;
  error?: string;
}

export interface Query {
  type: 'query';
  id: number;
  name: 'recent' | 'call' | 'stats';
  call_id?: string;
  limit?: number;
  /** stats: only calls started at or after this ISO instant. */
  since?: string;
  /** stats: width of each bucket in the volume series. */
  bucket_ms?: number;
  mode?: ClinicMode;
}

export type StoreMessage = CallStarted | TurnRow | CallEnded | SubmissionRow | Query;

/**
 * Worker → main, whenever a call's alerts change: after an agent turn (a leak shows while
 * the call is live), a submission, or the end. Broadcast to the console like a row.
 */
export interface CallAlerts {
  type: 'call_alerts';
  call_id: string;
  alerts: Alert[];
}
export interface QueryResult {
  type: 'query_result';
  id: number;
  rows: unknown;
  error?: string;
}
