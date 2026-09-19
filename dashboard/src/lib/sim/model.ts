/**
 * The shared clinic as the views read it: a hold list kept current from the event
 * stream, and each event turned into one line an operator can read.
 */
import type { Hold, SimEvent, SimEventType } from './wire';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface EventLine {
  id: number;
  at: number;
  type: SimEventType;
  callId: string | null;
  /** Short verb: "Hold", "Booked", "Conflict". */
  label: string;
  /** The rest: "PR03 · Tue 09:00 · taken by call 1a2b". */
  text: string;
  tone: Tone;
  /** The appointment the line is about, when it is about one. */
  appointmentId: string | null;
}

/** Everything the stream says that changes what a diary cell shows. */
export const DIARY_EVENTS: ReadonlySet<SimEventType> = new Set<SimEventType>([
  'snapshot',
  'reset',
  'hold',
  'hold_released',
  'hold_expired',
  'book',
  'reschedule',
  'cancel',
]);

/** Apply one event to the list of live holds. `hold` payloads are the Hold itself plus flags. */
export function applyHoldEvent(holds: Hold[], event: SimEvent): Hold[] {
  switch (event.type) {
    case 'hold': {
      const hold = asHold(event.data);
      if (!hold) return holds;
      return [...holds.filter((h) => h.hold_id !== hold.hold_id), hold];
    }
    case 'hold_released':
    case 'hold_expired': {
      const id = str(event.data.hold_id);
      return id ? holds.filter((h) => h.hold_id !== id) : holds;
    }
    case 'reset':
    case 'snapshot':
      return [];
    default:
      return holds;
  }
}

/** Holds still standing at `now` — the server sweeps expired ones lazily, so the client filters too. */
export function liveHolds(holds: Hold[], now: number): Hold[] {
  return holds.filter((h) => h.expires_at > now);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function asHold(data: Record<string, unknown>): Hold | null {
  const hold_id = str(data.hold_id);
  const call_id = str(data.call_id);
  const provider_id = str(data.provider_id);
  const location_id = str(data.location_id);
  const appointment_type_id = str(data.appointment_type_id);
  const start_time = str(data.start_time);
  const date = str(data.date);
  const minute = num(data.minute);
  const cells = num(data.cells);
  const created_at = num(data.created_at);
  const expires_at = num(data.expires_at);
  if (!hold_id || !call_id || !provider_id || !location_id || !appointment_type_id || !start_time || !date) return null;
  if (minute === null || cells === null || created_at === null || expires_at === null) return null;
  return {
    hold_id,
    call_id,
    provider_id,
    location_id,
    appointment_type_id,
    patient_id: str(data.patient_id),
    start_time,
    date,
    minute,
    cells,
    created_at,
    expires_at,
  };
}

/** 540 → "09:00" — a diary cell's minute of the clinic's day. */
export function minuteLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Holds by different calls tell apart by colour: a stable hue (0–359) per call id. */
export function callHue(callId: string): number {
  let h = 0;
  for (let i = 0; i < callId.length; i++) h = (h * 31 + callId.charCodeAt(i)) >>> 0;
  return (h % 12) * 30;
}

const slotClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** "Tue 23 Sep, 09:00" from a slot's ISO start. */
export function formatSlot(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : slotClock.format(t);
}

export function describe(event: SimEvent): EventLine {
  const d = event.data;
  const provider = str(d.provider_id);
  const slot = formatSlot(str(d.start_time));
  const where = provider ? `${provider} · ${slot}` : slot;
  const base = { id: event.id, at: event.at, type: event.type, callId: event.call_id, appointmentId: str(d.appointment_id) };

  switch (event.type) {
    case 'snapshot':
      return { ...base, label: 'Snapshot', text: 'clinic copied from the live API', tone: 'info' };
    case 'reset':
      return { ...base, label: 'Reset', text: 'back to the snapshot — bookings, holds and calls cleared', tone: 'warning' };
    case 'call_opened':
      return { ...base, label: 'Call opened', text: str(d.scenario) ?? str(d.from_number) ?? '', tone: 'neutral' };
    case 'call_closed':
      return { ...base, label: 'Call closed', text: 'submission window open for 30 s', tone: 'neutral' };
    case 'hold':
      return { ...base, label: d.renewed === true ? 'Hold renewed' : 'Hold', text: where, tone: 'info' };
    case 'hold_released':
      return { ...base, label: 'Released', text: str(d.reason) ? `${where} · ${String(d.reason)}` : where, tone: 'neutral' };
    case 'hold_expired':
      return { ...base, label: 'Hold expired', text: where, tone: 'warning' };
    case 'hold_conflict':
      return { ...base, label: 'Hold refused', text: `${where} · taken by ${by(d.taken_by)}`, tone: 'danger' };
    case 'book':
      return { ...base, label: 'Booked', text: `${where} · ${String(d.appointment_id ?? '')}`, tone: 'success' };
    case 'book_rejected':
      return { ...base, label: 'Booking refused', text: `${where} · taken by ${by(d.taken_by)}`, tone: 'danger' };
    case 'reschedule': {
      const to = isRecord(d.to) ? d.to : {};
      const toProvider = str(to.provider_id);
      const toSlot = formatSlot(str(to.start_time));
      return { ...base, label: 'Rescheduled', text: `${String(d.appointment_id ?? '')} → ${toProvider ?? ''} · ${toSlot}`, tone: 'success' };
    }
    case 'reschedule_rejected':
      return {
        ...base,
        label: 'Reschedule refused',
        text: d.taken_by ? `${where} · taken by ${by(d.taken_by)}` : `${String(d.appointment_id ?? '')} · ${str(d.reason) ?? 'refused'}`,
        tone: 'danger',
      };
    case 'cancel':
      return { ...base, label: 'Cancelled', text: `${String(d.appointment_id ?? '')} · ${where}`, tone: 'warning' };
    case 'cancel_rejected':
      return { ...base, label: 'Cancel refused', text: `${String(d.appointment_id ?? '')} unknown or already cancelled`, tone: 'danger' };
    case 'register':
      return { ...base, label: 'Registered', text: `${String(d.patient_id ?? '')}${d.insurer ? ` · ${String(d.insurer)}` : ''}`, tone: 'success' };
    case 'register_rejected':
      return { ...base, label: 'Register refused', text: `already on file as ${String(d.existing ?? '?')}`, tone: 'danger' };
    case 'no_action':
      return { ...base, label: 'No action', text: str(d.reason) ?? '', tone: 'neutral' };
    case 'escalate':
      return { ...base, label: 'Escalated', text: str(d.reason) ?? '', tone: 'warning' };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `taken_by` already reads as a phrase: "an existing appointment", "appointment L000012", "hold H000003 (call …)". */
const by = (v: unknown): string => str(v) ?? 'someone';
