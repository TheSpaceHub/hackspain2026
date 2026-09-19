/**
 * The shared clinic. Every call reads and writes the same one, and what one call
 * books the next call cannot: availability is computed from the persistent calendar
 * plus the holds other calls currently have, and each mutation is a single SQLite
 * transaction that re-checks the cells it is about to take.
 */
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { availability, type AvailabilityQuery, type AvailabilityResponse } from '../mock/rules/availability.js';
import { searchDirectory, type DirectoryQuery, type PatientMatch } from '../mock/rules/directory.js';
import { madridParts, todayMadrid, toInstant } from '../mock/rules/time.js';
import type { RecordedAction, Route } from '../mock/submit/schemas.js';
import { Catalogue, type Insurer } from '../mock/world/catalogue.js';
import { onLeave, workingCells, type Appointment } from '../mock/world/diary.js';
import type { Patient, PublicPatient } from '../mock/world/people.js';
import { nextCounter, transaction } from './db.js';
import type { ClinicBody, ProsperClient } from './prosper.js';

export const CELL = 15;
export const WINDOW_MS = 30_000;
export const DEFAULT_HOLD_TTL_MS = 120_000;

/** The plan rules the live API only shows in `blocked`; everything else is in the catalogue. */
export const HIDDEN_RESTRICTIONS = new Set(['insurer_referral_required', 'allowance_exhausted']);

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

export interface HoldRequest {
  call_id: string;
  provider_id: string;
  location_id: string;
  appointment_type_id: string;
  start_time: string;
  patient_id?: string;
  ttl_ms?: number;
}

export interface CallRow {
  call_id: string;
  opened_at: number;
  closed_at: number | null;
  from_number: string | null;
  scenario: string | null;
  last_received_at: number | null;
}

export interface StoredAppointment extends Appointment {
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
  /** Cells the provider sits, by minute of the day, with the site. */
  working: { location: string; minute: number }[];
  /** Cells taken: `ref` is an appointment_id, or 'snapshot' for one the live clinic showed as busy. */
  taken: { minute: number; ref: string }[];
}

export interface DiaryDay {
  date: string;
  closed: boolean;
  providers: DiaryProvider[];
  appointments: (StoredAppointment & { patient_name: string | null })[];
  holds: Hold[];
}

/** GET /__sim — where the clinic stands. */
export interface SimState {
  clinic_name: string;
  snapshot: { source: string; taken_at: string };
  live: string | null;
  hold_ttl_ms: number;
  calendar: Catalogue['calendar'];
  patients: { prosper: number; local: number };
  appointments: { prosper: number; local: number; cancelled: number };
  busy_cells: number;
  holds: number;
  calls: { total: number; open: number };
  events: number;
}

/** An answer that is also an HTTP status: the routes send it as-is. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; detail: string };

const conflict = (detail: string): Outcome<never> => ({ ok: false, status: 409, detail });
const invalid = (detail: string): Outcome<never> => ({ ok: false, status: 422, detail });
const missing = (detail: string): Outcome<never> => ({ ok: false, status: 404, detail });

interface SlotCheck {
  date: string;
  minute: number;
  cells: number;
  duration_minutes: number;
}

export interface ClinicOptions {
  db: DatabaseSync;
  /** The live API, for looking patients up on demand. Omitted or unconfigured → offline. */
  live?: ProsperClient | null;
  holdTtlMs?: number;
  /** Register an unknown call_id on its first hold or submission (the real API would 404). */
  acceptAnyCall?: boolean;
  log?: (line: string) => void;
}

export class Clinic extends EventEmitter<{ event: [SimEvent] }> {
  readonly db: DatabaseSync;
  catalogue!: Catalogue;
  clinicBody!: ClinicBody;
  openapi: unknown;
  readonly live: ProsperClient | null;
  readonly holdTtlMs: number;
  readonly acceptAnyCall: boolean;
  readonly #log: (line: string) => void;
  /** Directory queries already answered by the live API — asked once per process. */
  readonly #asked = new Set<string>();

  constructor(options: ClinicOptions) {
    super();
    this.db = options.db;
    this.live = options.live?.configured ? options.live : null;
    this.holdTtlMs = options.holdTtlMs ?? DEFAULT_HOLD_TTL_MS;
    this.acceptAnyCall = options.acceptAnyCall ?? true;
    this.#log = options.log ?? (() => {});
    this.reloadSnapshot();
  }

  /** Read the catalogue off the database again — after a re-snapshot rewrote it. */
  reloadSnapshot(): void {
    const snap = this.db.prepare('SELECT clinic_json, openapi_json FROM snapshot WHERE id = 1').get() as
      | { clinic_json: string; openapi_json: string | null }
      | undefined;
    if (!snap) throw new Error('no snapshot in the database — run the bootstrap first');
    this.clinicBody = JSON.parse(snap.clinic_json) as ClinicBody;
    this.openapi = snap.openapi_json ? (JSON.parse(snap.openapi_json) as unknown) : null;
    this.catalogue = new Catalogue(this.clinicBody);
    this.#asked.clear();
  }

  static hasSnapshot(db: DatabaseSync): boolean {
    return db.prepare('SELECT 1 FROM snapshot WHERE id = 1').get() !== undefined;
  }

  // --- events ---------------------------------------------------------------

  #emit(type: SimEventType, call_id: string | null, data: Record<string, unknown>, at = Date.now()): SimEvent {
    const res = this.db
      .prepare('INSERT INTO events(at, type, call_id, data_json) VALUES (?, ?, ?, ?)')
      .run(at, type, call_id, JSON.stringify(data));
    const event: SimEvent = { id: Number(res.lastInsertRowid), at, type, call_id, data };
    // Listeners hear it after the transaction commits, never a state that may roll back.
    if (this.db.isTransaction) queueMicrotask(() => this.emit('event', event));
    else this.emit('event', event);
    return event;
  }

  eventsSince(id: number, limit = 500): SimEvent[] {
    const rows = this.db
      .prepare('SELECT id, at, type, call_id, data_json FROM events WHERE id > ? ORDER BY id LIMIT ?')
      .all(id, limit) as { id: number; at: number; type: SimEventType; call_id: string | null; data_json: string }[];
    return rows.map((r) => ({ id: r.id, at: r.at, type: r.type, call_id: r.call_id, data: JSON.parse(r.data_json) as Record<string, unknown> }));
  }

  /** The newest `limit` events, oldest first — what a console shows before it starts streaming. */
  recentEvents(limit = 100): SimEvent[] {
    const rows = this.db
      .prepare('SELECT id, at, type, call_id, data_json FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as { id: number; at: number; type: SimEventType; call_id: string | null; data_json: string }[];
    return rows.reverse().map((r) => ({ id: r.id, at: r.at, type: r.type, call_id: r.call_id, data: JSON.parse(r.data_json) as Record<string, unknown> }));
  }

  // --- catalogue ------------------------------------------------------------

  /** /clinic as the live API shaped it, with the counts following what this clinic now holds. */
  clinic(): ClinicBody {
    const locals = (this.db.prepare(`SELECT COUNT(*) AS n FROM patients WHERE source = 'local'`).get() as { n: number }).n;
    const booked = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE source = 'local' AND status = 'active'`).get() as { n: number }
    ).n;
    const cancelled = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE source = 'prosper' AND status = 'cancelled'`).get() as { n: number }
    ).n;
    return {
      ...this.clinicBody,
      patient_count: this.clinicBody.patient_count + locals,
      calendar: { ...this.clinicBody.calendar, appointment_count: this.clinicBody.calendar.appointment_count + booked - cancelled },
    };
  }

  // --- patients -------------------------------------------------------------

  #toPatient(record: PublicPatient): Patient {
    return { ...record, manner: null, second_plan: null, allowance_spent: {} };
  }

  patient(id: string): Patient | undefined {
    const row = this.db.prepare('SELECT record_json FROM patients WHERE patient_id = ?').get(id) as { record_json: string } | undefined;
    return row ? this.#toPatient(JSON.parse(row.record_json) as PublicPatient) : undefined;
  }

  patients(): Patient[] {
    const rows = this.db.prepare('SELECT record_json FROM patients').all() as { record_json: string }[];
    return rows.map((r) => this.#toPatient(JSON.parse(r.record_json) as PublicPatient));
  }

  /**
   * Copy a live patient in: the record, and their diary. Upcoming visits take cells
   * under their own id so a CANCEL here frees them; the snapshot sweep already had
   * them busy, the ref just gets a name.
   */
  async #adopt(match: PatientMatch): Promise<void> {
    const { match_score: _s, matched_fields: _f, ...record } = match;
    const known = this.db.prepare('SELECT 1 FROM patients WHERE patient_id = ?').get(record.patient_id);
    if (known) return;
    let appointments: Appointment[] = [];
    if (this.live) {
      try {
        appointments = (await this.live.appointments(record.patient_id, 'all')).appointments;
      } catch (err) {
        this.#log(`directory: ${record.patient_id} diary not copied: ${String(err)}`);
      }
    }
    const now = Date.now();
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT OR IGNORE INTO patients(patient_id, source, record_json, created_at) VALUES (?, 'prosper', ?, ?)`)
        .run(record.patient_id, JSON.stringify(record), now);
      for (const a of appointments) {
        const existed = this.db.prepare('SELECT 1 FROM appointments WHERE appointment_id = ?').get(a.appointment_id);
        if (existed) continue;
        this.db
          .prepare(
            `INSERT INTO appointments(appointment_id, source, patient_id, provider_id, location_id, appointment_type_id, start_time, duration_minutes, status, call_id, created_at, updated_at)
             VALUES (?, 'prosper', ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
          )
          .run(a.appointment_id, a.patient_id, a.provider_id, a.location_id, a.appointment_type_id, a.start_time, a.duration_minutes, now, now);
        const { date, minutes } = madridParts(toInstant(a.start_time));
        if (date >= this.catalogue.calendar.starts) {
          for (let i = 0; i < Math.ceil(a.duration_minutes / CELL); i++) {
            this.db
              .prepare(`INSERT OR REPLACE INTO cells(provider_id, date, minute, ref) VALUES (?, ?, ?, ?)`)
              .run(a.provider_id, date, minutes + i * CELL, a.appointment_id);
          }
        }
      }
    });
  }

  /**
   * The directory: whoever is on file here, and — the first time a query is asked —
   * whoever the live API knows by it. Patients found live are copied in for good.
   */
  async directory(q: DirectoryQuery): Promise<PatientMatch[] | null> {
    const key = JSON.stringify([q.name ?? '', q.national_id ?? '', q.phone ?? '', q.date_of_birth ?? '']);
    if (this.live && !this.#asked.has(key)) {
      try {
        const { matches } = await this.live.directory(q);
        for (const m of matches) await this.#adopt(m);
        this.#asked.add(key);
      } catch (err) {
        this.#log(`directory: live lookup failed: ${String(err)}`);
      }
    }
    return searchDirectory(this.patients(), q);
  }

  appointmentsFor(patientId: string, when: 'upcoming' | 'past' | 'all', now = Date.now()): Appointment[] {
    const rows = this.db
      .prepare(
        `SELECT appointment_id, patient_id, provider_id, location_id, appointment_type_id, start_time, duration_minutes
         FROM appointments WHERE patient_id = ? AND status = 'active' ORDER BY start_time`,
      )
      .all(patientId) as unknown as Appointment[];
    return rows.filter((a) => {
      const past = Date.parse(a.start_time) < now;
      return when === 'all' || (when === 'past' ? past : !past);
    });
  }

  appointment(id: string): StoredAppointment | undefined {
    return this.db
      .prepare(
        `SELECT appointment_id, source, patient_id, provider_id, location_id, appointment_type_id, start_time, duration_minutes, status, call_id
         FROM appointments WHERE appointment_id = ?`,
      )
      .get(id) as StoredAppointment | undefined;
  }

  appointmentsOn(date: string, providerId?: string): StoredAppointment[] {
    const rows = this.db
      .prepare(
        `SELECT appointment_id, source, patient_id, provider_id, location_id, appointment_type_id, start_time, duration_minutes, status, call_id
         FROM appointments WHERE substr(start_time, 1, 10) = ? ${providerId ? 'AND provider_id = ?' : ''} ORDER BY start_time`,
      )
      .all(...(providerId ? [date, providerId] : [date])) as unknown as StoredAppointment[];
    return rows;
  }

  /**
   * One day of the diary, provider by provider: the cells each one works (with the
   * site), the ones taken (by which appointment, or 'snapshot' for a nameless one),
   * and the live holds on them. What a wall calendar of the clinic would show.
   */
  diary(date: string, now = Date.now()): DiaryDay {
    const closed = this.catalogue.calendar.closure_days.includes(date);
    const taken = this.db.prepare('SELECT provider_id, minute, ref FROM cells WHERE date = ?').all(date) as { provider_id: string; minute: number; ref: string }[];
    const byProvider = new Map<string, { minute: number; ref: string }[]>();
    for (const t of taken) {
      const list = byProvider.get(t.provider_id) ?? [];
      list.push({ minute: t.minute, ref: t.ref });
      byProvider.set(t.provider_id, list);
    }
    const providers: DiaryProvider[] = [];
    for (const p of this.catalogue.providers.values()) {
      const working = closed ? [] : workingCells(this.catalogue, p, date);
      providers.push({
        provider_id: p.id,
        name: p.name,
        specialty_id: p.specialty_id,
        specialty_name: p.specialty_name,
        on_leave: onLeave(p, date),
        working,
        taken: byProvider.get(p.id) ?? [],
      });
    }
    return {
      date,
      closed,
      providers,
      appointments: this.appointmentsOn(date).map((a) => {
        const p = this.patient(a.patient_id);
        return { ...a, patient_name: p ? `${p.given_name} ${p.first_surname}` : null };
      }),
      holds: this.holds(now).filter((h) => h.date === date),
    };
  }

  // --- the calendar ---------------------------------------------------------

  /** Free of appointments and of other calls' holds. `callId` sees through its own holds. */
  isFree(provider: string, date: string, minute: number, cells: number, callId: string | null, now = Date.now(), ignoreRef: string | null = null): boolean {
    const last = minute + (cells - 1) * CELL;
    const busy = this.db
      .prepare('SELECT 1 FROM cells WHERE provider_id = ? AND date = ? AND minute BETWEEN ? AND ? AND ref IS NOT ? LIMIT 1')
      .get(provider, date, minute, last, ignoreRef);
    if (busy) return false;
    const held = this.db
      .prepare(
        `SELECT 1 FROM holds WHERE provider_id = ? AND date = ? AND expires_at > ? AND call_id IS NOT ?
         AND minute < ? AND minute + cells * ${CELL} > ? LIMIT 1`,
      )
      .get(provider, date, now, callId, last + CELL, minute);
    return !held;
  }

  /** Who is in the way at these cells: the appointment ref, or the hold and its call. */
  #occupant(provider: string, date: string, minute: number, cells: number, callId: string | null, now: number, ignoreRef: string | null = null): string {
    const last = minute + (cells - 1) * CELL;
    const cell = this.db
      .prepare('SELECT ref FROM cells WHERE provider_id = ? AND date = ? AND minute BETWEEN ? AND ? AND ref IS NOT ? LIMIT 1')
      .get(provider, date, minute, last, ignoreRef) as { ref: string } | undefined;
    if (cell) return cell.ref === 'snapshot' ? 'an existing appointment' : `appointment ${cell.ref}`;
    const hold = this.db
      .prepare(
        `SELECT hold_id, call_id FROM holds WHERE provider_id = ? AND date = ? AND expires_at > ? AND call_id IS NOT ?
         AND minute < ? AND minute + cells * ${CELL} > ? LIMIT 1`,
      )
      .get(provider, date, now, callId, last + CELL, minute) as { hold_id: string; call_id: string } | undefined;
    return hold ? `hold ${hold.hold_id} (call ${hold.call_id})` : 'nothing';
  }

  /** A hidden plan rule learnt from the live API; null means "asked, and it let it through". */
  hiddenPlanRule(patient: Patient, plan: Insurer, specialtyId: string): string | null {
    const row = this.db
      .prepare('SELECT restriction FROM plan_rules WHERE patient_id = ? AND plan = ? AND specialty_id = ?')
      .get(patient.patient_id, plan, specialtyId) as { restriction: string | null } | undefined;
    return row?.restriction ?? null;
  }

  /**
   * Ask the live API, once per (patient, plan, specialty), whether it hides a rule we
   * cannot compute — a referral the insurer wants, an allowance spent this year.
   */
  async learnPlanRules(patientId: string, plans: Insurer[], specialtyIds: string[]): Promise<void> {
    if (!this.live) return;
    const patient = this.patient(patientId);
    if (!patient) return;
    const { starts, ends } = this.catalogue.calendar;
    const from = todayMadrid() > starts ? todayMadrid() : starts;
    if (from > ends) return;
    for (const plan of plans) {
      for (const specialty of specialtyIds) {
        const known = this.db
          .prepare('SELECT 1 FROM plan_rules WHERE patient_id = ? AND plan = ? AND specialty_id = ?')
          .get(patientId, plan, specialty);
        if (known) continue;
        let restriction: string | null = null;
        try {
          const res = await this.live.availability({ date_from: from, date_to: from, specialty_id: specialty, patient_id: patientId, insurer: [plan] });
          restriction = res.blocked.find((b) => HIDDEN_RESTRICTIONS.has(b.restriction))?.restriction ?? null;
        } catch (err) {
          this.#log(`plan rules: ${patientId}/${plan}/${specialty} not learnt: ${String(err)}`);
          continue;
        }
        this.db
          .prepare('INSERT OR REPLACE INTO plan_rules(patient_id, plan, specialty_id, restriction) VALUES (?, ?, ?, ?)')
          .run(patientId, plan, specialty, restriction);
      }
    }
  }

  availability(q: AvailabilityQuery, now = Date.now(), callId: string | null = null): AvailabilityResponse {
    return availability(
      {
        catalogue: this.catalogue,
        patient: (id) => this.patient(id),
        diary: { isFree: (p, d, m, c) => this.isFree(p, d, m, c, callId, now) },
        hiddenPlanRule: (patient, plan, specialty) => this.hiddenPlanRule(patient, plan, specialty),
      },
      q,
      now,
    );
  }

  /** Everything about a slot that is true regardless of who else wants it. */
  #checkSlot(providerId: string, locationId: string, typeId: string, startTime: string): Outcome<SlotCheck> {
    const cat = this.catalogue;
    const provider = cat.providers.get(providerId);
    if (!provider) return invalid(`unknown provider_id '${providerId}'`);
    if (!cat.locations.has(locationId)) return invalid(`unknown location_id '${locationId}'`);
    const type = cat.types.get(typeId);
    if (!type) return invalid(`unknown appointment_type_id '${typeId}'`);
    if (!cat.typesOf(provider).has(typeId)) return invalid(`${provider.name} does not do '${type.name}'`);
    const instant = toInstant(startTime);
    if (!Number.isFinite(instant)) return invalid(`slot '${startTime}' is not a valid datetime`);
    const { date, minutes } = madridParts(instant);
    const { starts, ends, closure_days } = cat.calendar;
    if (date < starts || date > ends) return invalid(`the calendar runs ${starts} to ${ends}; ${date} is outside it`);
    if (closure_days.includes(date)) return invalid(`${date} is a closure day`);
    if (minutes % CELL !== 0) return invalid(`slots start on the quarter hour; ${startTime} does not`);
    if (onLeave(provider, date)) return invalid(`${provider.name} is on leave on ${date}`);
    const cells = Math.ceil(type.duration_minutes / CELL);
    const working = new Set(workingCells(cat, provider, date).filter((c) => c.location === locationId).map((c) => c.minute));
    for (let i = 0; i < cells; i++) {
      if (!working.has(minutes + i * CELL)) return invalid(`${provider.name} is not at ${locationId} at ${startTime} for ${type.duration_minutes} minutes`);
    }
    return { ok: true, value: { date, minute: minutes, cells, duration_minutes: type.duration_minutes } };
  }

  // --- holds ----------------------------------------------------------------

  #hold(id: string): Hold | undefined {
    return this.db.prepare('SELECT * FROM holds WHERE hold_id = ?').get(id) as Hold | undefined;
  }

  holds(now = Date.now()): Hold[] {
    return this.db.prepare('SELECT * FROM holds WHERE expires_at > ? ORDER BY created_at').all(now) as unknown as Hold[];
  }

  /**
   * Claim the cells for a while. Fails with 409 when another call holds or has booked
   * them; a call asking again for the same slot just gets its hold renewed.
   */
  hold(req: HoldRequest, now = Date.now()): Outcome<Hold> {
    return transaction(this.db, () => {
      this.expireHolds(now);
      const call = this.#callFor(req.call_id, now);
      if (!call.ok) return call;
      const slot = this.#checkSlot(req.provider_id, req.location_id, req.appointment_type_id, req.start_time);
      if (!slot.ok) return slot;
      const { date, minute, cells } = slot.value;
      if (!this.isFree(req.provider_id, date, minute, cells, req.call_id, now)) {
        const by = this.#occupant(req.provider_id, date, minute, cells, req.call_id, now);
        this.#emit('hold_conflict', req.call_id, { provider_id: req.provider_id, start_time: req.start_time, taken_by: by }, now);
        return conflict(`${req.start_time} with ${req.provider_id} is taken by ${by}`);
      }
      const ttl = Math.max(1_000, Math.min(req.ttl_ms ?? this.holdTtlMs, 15 * 60_000));
      const same = this.db
        .prepare('SELECT hold_id FROM holds WHERE call_id = ? AND provider_id = ? AND date = ? AND minute = ? AND expires_at > ?')
        .get(req.call_id, req.provider_id, date, minute, now) as { hold_id: string } | undefined;
      const hold_id = same?.hold_id ?? `H${String(nextCounter(this.db, 'hold')).padStart(6, '0')}`;
      this.db
        .prepare(
          `INSERT OR REPLACE INTO holds(hold_id, call_id, provider_id, location_id, appointment_type_id, patient_id, start_time, date, minute, cells, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(hold_id, req.call_id, req.provider_id, req.location_id, req.appointment_type_id, req.patient_id ?? null, req.start_time, date, minute, cells, now, now + ttl);
      const hold = this.#hold(hold_id)!;
      this.#emit('hold', req.call_id, { ...hold, renewed: same !== undefined }, now);
      return { ok: true, value: hold };
    });
  }

  release(holdId: string, callId: string | null, now = Date.now()): Outcome<Hold> {
    return transaction(this.db, () => {
      const hold = this.#hold(holdId);
      if (!hold) return missing(`unknown hold ${holdId}`);
      if (callId !== null && hold.call_id !== callId) return conflict(`hold ${holdId} belongs to call ${hold.call_id}`);
      this.db.prepare('DELETE FROM holds WHERE hold_id = ?').run(holdId);
      this.#emit('hold_released', hold.call_id, { ...hold }, now);
      return { ok: true, value: hold };
    });
  }

  /** Drop every hold a call has — it booked, submitted, or hung up. */
  releaseAll(callId: string, now = Date.now(), reason = 'released'): Hold[] {
    return transaction(this.db, () => {
      const held = this.db.prepare('SELECT * FROM holds WHERE call_id = ?').all(callId) as unknown as Hold[];
      this.db.prepare('DELETE FROM holds WHERE call_id = ?').run(callId);
      for (const h of held) this.#emit('hold_released', callId, { ...h, reason }, now);
      return held;
    });
  }

  expireHolds(now = Date.now()): Hold[] {
    return transaction(this.db, () => {
      const gone = this.db.prepare('SELECT * FROM holds WHERE expires_at <= ?').all(now) as unknown as Hold[];
      if (gone.length === 0) return gone;
      this.db.prepare('DELETE FROM holds WHERE expires_at <= ?').run(now);
      for (const h of gone) this.#emit('hold_expired', h.call_id, { ...h }, now);
      return gone;
    });
  }

  // --- calls ----------------------------------------------------------------

  call(callId: string): CallRow | undefined {
    return this.db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId) as CallRow | undefined;
  }

  calls(limit = 200): (CallRow & { actions: RecordedAction[] })[] {
    const rows = this.db.prepare('SELECT * FROM calls ORDER BY opened_at DESC LIMIT ?').all(limit) as unknown as CallRow[];
    return rows.map((c) => ({ ...c, actions: this.actions(c.call_id) }));
  }

  upcomingAppointment(patientId: string, now = Date.now()): StoredAppointment | undefined {
    const rows = this.db
      .prepare("SELECT * FROM appointments WHERE patient_id = ? AND status = 'active'")
      .all(patientId) as unknown as StoredAppointment[];
    return rows
      .filter((appointment) => Date.parse(appointment.start_time) > now)
      .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))[0];
  }

  actions(callId: string): RecordedAction[] {
    const rows = this.db.prepare('SELECT action_json FROM actions WHERE call_id = ? ORDER BY id').all(callId) as { action_json: string }[];
    return rows.map((r) => JSON.parse(r.action_json) as RecordedAction);
  }

  openCall(callId: string, meta: { from_number?: string | null; scenario?: string | null } = {}, now = Date.now()): CallRow {
    return transaction(this.db, () => {
      const existing = this.call(callId);
      if (existing) return existing;
      this.db
        .prepare('INSERT INTO calls(call_id, opened_at, closed_at, from_number, scenario, last_received_at) VALUES (?, ?, NULL, ?, ?, NULL)')
        .run(callId, now, meta.from_number ?? null, meta.scenario ?? null);
      this.#emit('call_opened', callId, { from_number: meta.from_number ?? null, scenario: meta.scenario ?? null }, now);
      return this.call(callId)!;
    });
  }

  /** The socket closed: the 30 s window starts, and the caller is no longer deciding anything. */
  closeCall(callId: string, now = Date.now()): CallRow | undefined {
    return transaction(this.db, () => {
      const call = this.call(callId);
      if (!call) return undefined;
      if (call.closed_at === null) {
        this.db.prepare('UPDATE calls SET closed_at = ? WHERE call_id = ?').run(now, callId);
        this.releaseAll(callId, now, 'call_closed');
        this.#emit('call_closed', callId, { window_closes_at: now + WINDOW_MS }, now);
      }
      return this.call(callId);
    });
  }

  #callFor(callId: string, now: number): Outcome<CallRow> {
    const call = this.call(callId) ?? (this.acceptAnyCall ? this.openCall(callId, {}, now) : undefined);
    if (!call) return missing(`unknown call ${callId}`);
    return { ok: true, value: call };
  }

  /** What GET /submissions returns: the most recent records, newest first. */
  records(limit: number): { call_id: string; record: { actions: RecordedAction[] }; received_at: string }[] {
    const rows = this.db
      .prepare('SELECT call_id, last_received_at FROM calls WHERE last_received_at IS NOT NULL ORDER BY last_received_at DESC LIMIT ?')
      .all(limit) as { call_id: string; last_received_at: number }[];
    return rows.map((r) => ({ call_id: r.call_id, record: { actions: this.actions(r.call_id) }, received_at: new Date(r.last_received_at).toISOString() }));
  }

  // --- submissions: the clinic changes here -----------------------------------

  /**
   * One submitted action, applied. The window and the duplicate check come first, as
   * on the real API; then the action is applied to the clinic, and only an action that
   * took effect goes on the record.
   */
  submit(
    route: Route,
    data: Record<string, unknown> & { call_id: string },
    action: RecordedAction,
    now = Date.now(),
  ): Outcome<{ call: CallRow; actions: RecordedAction[]; result: Record<string, unknown> }> {
    return transaction(this.db, () => {
      this.expireHolds(now);
      const found = this.#callFor(data.call_id, now);
      if (!found.ok) return found;
      const call = found.value;
      if (call.closed_at !== null && now - call.closed_at > WINDOW_MS) {
        return { ok: false, status: 410, detail: `submission window for call ${call.call_id} closed at ${new Date(call.closed_at + WINDOW_MS).toISOString()}` };
      }
      const key = canonical(action);
      if (this.actions(call.call_id).some((a) => canonical(a) === key)) {
        return conflict(`an identical ${action.action} was already accepted for call ${call.call_id}`);
      }

      const applied = this.#apply(route, data, now);
      if (!applied.ok) return applied;

      this.db.prepare('INSERT INTO actions(call_id, action_json, received_at) VALUES (?, ?, ?)').run(call.call_id, JSON.stringify(action), now);
      this.db.prepare('UPDATE calls SET last_received_at = ? WHERE call_id = ?').run(now, call.call_id);
      // Whatever the call was holding, it has decided now.
      this.releaseAll(call.call_id, now, 'submitted');
      return { ok: true, value: { call: this.call(call.call_id)!, actions: this.actions(call.call_id), result: applied.value } };
    });
  }

  #apply(route: Route, d: Record<string, unknown> & { call_id: string }, now: number): Outcome<Record<string, unknown>> {
    const callId = d.call_id;
    switch (route) {
      case 'register': {
        const nationalId = String(d.national_id);
        const dup = this.patients().find((p) => p.national_id === nationalId);
        if (dup) {
          this.#emit('register_rejected', callId, { national_id: nationalId, existing: dup.patient_id }, now);
          return conflict(`a patient with national_id ${nationalId} is already on file (${dup.patient_id})`);
        }
        const patient_id = `P9${String(nextCounter(this.db, 'patient')).padStart(4, '0')}`;
        const record: PublicPatient = {
          patient_id,
          given_name: String(d.given_name),
          first_surname: String(d.first_surname),
          second_surname: String(d.second_surname ?? ''),
          national_id: nationalId,
          date_of_birth: String(d.date_of_birth),
          phone: String(d.phone).replace(/\D/g, '').slice(-9),
          sex: 'F',
          has_visited_before: false,
          insurer: d.insurer as Insurer,
          referrals: [],
          note: `Registered by phone on ${new Date(now).toISOString().slice(0, 10)} (call ${callId}).`,
        };
        this.db
          .prepare(`INSERT INTO patients(patient_id, source, record_json, created_at) VALUES (?, 'local', ?, ?)`)
          .run(patient_id, JSON.stringify(record), now);
        this.#emit('register', callId, { patient_id, national_id: nationalId, insurer: record.insurer }, now);
        return { ok: true, value: { patient_id } };
      }
      case 'book': {
        const slot = this.#checkSlot(String(d.provider_id), String(d.location_id), String(d.appointment_type_id), String(d.slot));
        if (!slot.ok) return slot;
        const patientId = String(d.patient_id);
        const { date, minute, cells, duration_minutes } = slot.value;
        if (!this.isFree(String(d.provider_id), date, minute, cells, callId, now)) {
          const by = this.#occupant(String(d.provider_id), date, minute, cells, callId, now);
          this.#emit('book_rejected', callId, { patient_id: patientId, provider_id: d.provider_id, start_time: d.slot, taken_by: by }, now);
          return conflict(`${String(d.slot)} with ${String(d.provider_id)} is taken by ${by}`);
        }
        const appointment_id = `L${String(nextCounter(this.db, 'appointment')).padStart(6, '0')}`;
        this.db
          .prepare(
            `INSERT INTO appointments(appointment_id, source, patient_id, provider_id, location_id, appointment_type_id, start_time, duration_minutes, status, call_id, created_at, updated_at)
             VALUES (?, 'local', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(appointment_id, patientId, String(d.provider_id), String(d.location_id), String(d.appointment_type_id), String(d.slot), duration_minutes, callId, now, now);
        this.#take(String(d.provider_id), date, minute, cells, appointment_id);
        this.#emit('book', callId, { appointment_id, patient_id: patientId, provider_id: d.provider_id, location_id: d.location_id, appointment_type_id: d.appointment_type_id, start_time: d.slot, duration_minutes, policy_id: d.policy_id }, now);
        return { ok: true, value: { appointment_id } };
      }
      case 'reschedule': {
        const appt = this.appointment(String(d.appointment_id));
        if (!appt || appt.status !== 'active') {
          this.#emit('reschedule_rejected', callId, { appointment_id: d.appointment_id, reason: 'unknown' }, now);
          return missing(`unknown appointment ${String(d.appointment_id)}`);
        }
        if (Date.parse(appt.start_time) < now) return conflict(`appointment ${appt.appointment_id} is in the past`);
        const slot = this.#checkSlot(String(d.provider_id), String(d.location_id), appt.appointment_type_id, String(d.slot));
        if (!slot.ok) return slot;
        const { date, minute, cells, duration_minutes } = slot.value;
        // The old cells are its own, so they do not stand in the way of moving a little.
        if (!this.isFree(String(d.provider_id), date, minute, cells, callId, now, appt.appointment_id)) {
          const by = this.#occupant(String(d.provider_id), date, minute, cells, callId, now, appt.appointment_id);
          this.#emit('reschedule_rejected', callId, { appointment_id: appt.appointment_id, start_time: d.slot, taken_by: by }, now);
          return conflict(`${String(d.slot)} with ${String(d.provider_id)} is taken by ${by}`);
        }
        this.db.prepare('DELETE FROM cells WHERE ref = ?').run(appt.appointment_id);
        this.db
          .prepare(`UPDATE appointments SET provider_id = ?, location_id = ?, start_time = ?, duration_minutes = ?, call_id = ?, updated_at = ? WHERE appointment_id = ?`)
          .run(String(d.provider_id), String(d.location_id), String(d.slot), duration_minutes, callId, now, appt.appointment_id);
        this.#take(String(d.provider_id), date, minute, cells, appt.appointment_id);
        this.#emit('reschedule', callId, { appointment_id: appt.appointment_id, patient_id: appt.patient_id, from: { provider_id: appt.provider_id, start_time: appt.start_time }, to: { provider_id: d.provider_id, location_id: d.location_id, start_time: d.slot } }, now);
        return { ok: true, value: {} };
      }
      case 'cancel': {
        const appt = this.appointment(String(d.appointment_id));
        if (!appt || appt.status !== 'active') {
          this.#emit('cancel_rejected', callId, { appointment_id: d.appointment_id }, now);
          return missing(`unknown appointment ${String(d.appointment_id)}`);
        }
        if (Date.parse(appt.start_time) < now) return conflict(`appointment ${appt.appointment_id} is in the past`);
        this.db.prepare(`UPDATE appointments SET status = 'cancelled', call_id = ?, updated_at = ? WHERE appointment_id = ?`).run(callId, now, appt.appointment_id);
        this.db.prepare('DELETE FROM cells WHERE ref = ?').run(appt.appointment_id);
        this.#emit('cancel', callId, { appointment_id: appt.appointment_id, patient_id: appt.patient_id, provider_id: appt.provider_id, start_time: appt.start_time }, now);
        return { ok: true, value: {} };
      }
      case 'no-action':
        this.#emit('no_action', callId, { reason: d.reason }, now);
        return { ok: true, value: {} };
      case 'escalate':
        this.#emit('escalate', callId, { reason: d.reason }, now);
        return { ok: true, value: {} };
    }
  }

  #take(provider: string, date: string, minute: number, cells: number, ref: string): void {
    for (let i = 0; i < cells; i++) {
      this.db.prepare('INSERT INTO cells(provider_id, date, minute, ref) VALUES (?, ?, ?, ?)').run(provider, date, minute + i * CELL, ref);
    }
  }

  // --- reset ----------------------------------------------------------------

  /**
   * Back to the snapshot: every call, hold, booking, cancellation and registration undone,
   * and the log cleared with them — only the `reset` line remains. Event ids keep counting
   * up (AUTOINCREMENT), so a console streaming `?since=` is not confused.
   */
  reset(now = Date.now()): void {
    transaction(this.db, () => {
      this.db.exec(`
        DELETE FROM holds;
        DELETE FROM calls;
        DELETE FROM actions;
        DELETE FROM patients WHERE source = 'local';
        DELETE FROM appointments WHERE source = 'local';
        UPDATE appointments SET status = 'active', call_id = NULL;
        DELETE FROM cells;
        INSERT INTO cells(provider_id, date, minute, ref) SELECT provider_id, date, minute, 'snapshot' FROM snapshot_cells;
        DELETE FROM counters WHERE name IN ('hold', 'appointment', 'patient');
        DELETE FROM events;
      `);
      // Prosper appointments we copied keep their own cells, so a later CANCEL still frees them.
      const kept = this.db
        .prepare(`SELECT appointment_id, provider_id, start_time, duration_minutes FROM appointments WHERE source = 'prosper'`)
        .all() as Pick<Appointment, 'appointment_id' | 'provider_id' | 'start_time' | 'duration_minutes'>[];
      for (const a of kept) {
        const { date, minutes } = madridParts(toInstant(a.start_time));
        if (date < this.catalogue.calendar.starts) continue;
        for (let i = 0; i < Math.ceil(a.duration_minutes / CELL); i++) {
          this.db.prepare('INSERT OR REPLACE INTO cells(provider_id, date, minute, ref) VALUES (?, ?, ?, ?)').run(a.provider_id, date, minutes + i * CELL, a.appointment_id);
        }
      }
      this.#emit('reset', null, {}, now);
    });
  }

  // --- a look inside ----------------------------------------------------------

  state(now = Date.now()): SimState {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    const snap = this.db.prepare('SELECT source, taken_at FROM snapshot WHERE id = 1').get() as { source: string; taken_at: number };
    return {
      clinic_name: this.clinicBody.clinic_name,
      snapshot: { source: snap.source, taken_at: new Date(snap.taken_at).toISOString() },
      live: this.live ? this.live.baseUrl : null,
      hold_ttl_ms: this.holdTtlMs,
      calendar: this.catalogue.calendar,
      patients: { prosper: one(`SELECT COUNT(*) AS n FROM patients WHERE source = 'prosper'`), local: one(`SELECT COUNT(*) AS n FROM patients WHERE source = 'local'`) },
      appointments: {
        prosper: one(`SELECT COUNT(*) AS n FROM appointments WHERE source = 'prosper' AND status = 'active'`),
        local: one(`SELECT COUNT(*) AS n FROM appointments WHERE source = 'local' AND status = 'active'`),
        cancelled: one(`SELECT COUNT(*) AS n FROM appointments WHERE status = 'cancelled'`),
      },
      busy_cells: one('SELECT COUNT(*) AS n FROM cells'),
      holds: this.holds(now).length,
      calls: { total: one('SELECT COUNT(*) AS n FROM calls'), open: one('SELECT COUNT(*) AS n FROM calls WHERE closed_at IS NULL') },
      events: one('SELECT COUNT(*) AS n FROM events'),
    };
  }
}

/** Two bodies that mean the same thing are the same action, whatever the key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
