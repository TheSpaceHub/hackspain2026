/**
 * What the shared clinic (sim/) sends, in its own snake_case. Mirrors the exported
 * shapes in sim/clinic.ts (SimEvent, Hold, StoredAppointment, DiaryDay, SimState);
 * the sim's compiler options keep it from being imported here type-only, so this
 * copy is kept by hand — change both sides together.
 *
 * Nothing outside src/lib/sim should touch these; model.ts turns them into what
 * the views read.
 */

export type SimEventType =
  | 'snapshot'
  | 'reset'
  | 'call_opened'
  | 'call_closed'
  | 'hold'
  | 'hold_released'
  | 'hold_expired'
  | 'hold_conflict'
  | 'book'
  | 'book_rejected'
  | 'reschedule'
  | 'reschedule_rejected'
  | 'cancel'
  | 'cancel_rejected'
  | 'register'
  | 'register_rejected'
  | 'no_action'
  | 'escalate';

/** One line of the sim's log; `data` varies by type (hold, appointment, detail, …). */
export interface SimEvent {
  id: number;
  at: number;
  type: SimEventType;
  call_id: string | null;
  data: Record<string, unknown>;
}

export interface Hold {
  hold_id: string;
  call_id: string;
  provider_id: string;
  location_id: string;
  appointment_type_id: string;
  patient_id: string | null;
  start_time: string;
  date: string;
  minute: number;
  cells: number;
  created_at: number;
  expires_at: number;
}

export interface StoredAppointment {
  appointment_id: string;
  patient_id: string;
  provider_id: string;
  location_id: string;
  appointment_type_id: string;
  start_time: string;
  duration_minutes: number;
  source: 'prosper' | 'local';
  status: 'active' | 'cancelled';
  call_id: string | null;
}

export interface DiaryProvider {
  provider_id: string;
  name: string;
  specialty_id: string;
  specialty_name: string;
  on_leave: boolean;
  working: { location: string; minute: number }[];
  /** `ref` is an appointment_id, or 'snapshot' for a cell the live clinic showed as busy. */
  taken: { minute: number; ref: string }[];
}

/** GET /__sim/diary?date= */
export interface DiaryDay {
  date: string;
  closed: boolean;
  providers: DiaryProvider[];
  appointments: (StoredAppointment & { patient_name: string | null })[];
  holds: Hold[];
}

/** GET /__sim */
export interface SimState {
  clinic_name: string;
  snapshot: { source: string; taken_at: string };
  live: string | null;
  hold_ttl_ms: number;
  calendar: { starts: string; ends: string; max_span_days: number; slot_minutes: number; closure_days: string[] };
  patients: { prosper: number; local: number };
  appointments: { prosper: number; local: number; cancelled: number };
  busy_cells: number;
  holds: number;
  calls: { total: number; open: number };
  events: number;
}

export interface SimCall {
  call_id: string;
  opened_at: number;
  closed_at: number | null;
  from_number: string | null;
  scenario: string | null;
}
