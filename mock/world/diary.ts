/**
 * Invented diaries: every patient's visit history (2024–2025, never bookable, there
 * to be read back) and the event calendar's appointments, which are what makes a
 * slot taken. Also writes each patient's receptionist note, since the note is a
 * summary of that history.
 */
import { addDays, ageInMonths, eachDay, madridIso, parseInterval, weekdayOf } from '../rules/time.js';
import { type Catalogue, type Provider } from './catalogue.js';
import { ANCHORS, type Patient } from './people.js';
import type { Random } from './random.js';

export interface Appointment {
  appointment_id: string;
  patient_id: string;
  provider_id: string;
  location_id: string;
  appointment_type_id: string;
  start_time: string;
  duration_minutes: number;
}

const CELL = 15;

/** A provider's working cells on a date: [location, start minute] per 15-minute step. */
export function workingCells(cat: Catalogue, provider: Provider, date: string): { location: string; minute: number }[] {
  const weekday = weekdayOf(date);
  const out: { location: string; minute: number }[] = [];
  for (const schedule of provider.schedules) {
    const day = schedule.days.find((d) => d.weekday === weekday);
    const siteDay = cat.locations.get(schedule.location_id)?.hours.find((d) => d.weekday === weekday);
    if (!day || !siteDay) continue;
    for (const interval of day.intervals) {
      const [from, to] = parseInterval(interval);
      for (let m = from; m + CELL <= to; m += CELL) {
        // A provider sits only while the site is open.
        if (siteDay.intervals.some((si) => { const [a, b] = parseInterval(si); return m >= a && m + CELL <= b; })) {
          out.push({ location: schedule.location_id, minute: m });
        }
      }
    }
  }
  return out;
}

export function onLeave(provider: Provider, date: string): boolean {
  return !!provider.leave && date >= provider.leave.start && date <= provider.leave.end;
}

/** Who a specialty can see, on the record's own terms — used to fill diaries plausibly. */
function eligible(cat: Catalogue, p: Patient, specialtyId: string, on: string): boolean {
  const s = cat.specialties.get(specialtyId)!;
  const age = ageInMonths(p.date_of_birth, on);
  if (age < s.min_age_months || (s.max_age_months !== null && age > s.max_age_months)) return false;
  if (specialtyId === 'gynaecology' && p.sex !== 'F') return false;
  if (s.referral_required && !p.referrals.includes(specialtyId)) return false;
  return cat.planCoversSpecialty(p.insurer, specialtyId);
}

export class Diary {
  readonly appointments: Appointment[] = [];
  readonly #taken = new Map<string, Set<number>>(); // `${provider}|${date}` → busy minutes
  #next = 1;

  constructor(private readonly cat: Catalogue) {}

  #key(provider: string, date: string): string {
    return `${provider}|${date}`;
  }

  isFree(provider: string, date: string, minute: number, cells: number): boolean {
    const busy = this.#taken.get(this.#key(provider, date));
    for (let i = 0; i < cells; i++) if (busy?.has(minute + i * CELL)) return false;
    return true;
  }

  add(a: Omit<Appointment, 'appointment_id' | 'start_time'> & { date: string; minute: number }, calendar: boolean): Appointment {
    const appt: Appointment = {
      appointment_id: `A${String(this.#next++).padStart(6, '0')}`,
      patient_id: a.patient_id,
      provider_id: a.provider_id,
      location_id: a.location_id,
      appointment_type_id: a.appointment_type_id,
      start_time: madridIso(a.date, a.minute),
      duration_minutes: a.duration_minutes,
    };
    // History never blocks the calendar; only calendar appointments take cells.
    if (calendar) {
      const key = this.#key(a.provider_id, a.date);
      const busy = this.#taken.get(key) ?? new Set<number>();
      for (let i = 0; i < Math.ceil(a.duration_minutes / CELL); i++) busy.add(a.minute + i * CELL);
      this.#taken.set(key, busy);
    }
    this.appointments.push(appt);
    return appt;
  }

  forPatient(patientId: string): Appointment[] {
    return this.appointments
      .filter((a) => a.patient_id === patientId)
      .sort((x, y) => Date.parse(x.start_time) - Date.parse(y.start_time));
  }

  get(appointmentId: string): Appointment | undefined {
    return this.appointments.find((a) => a.appointment_id === appointmentId);
  }
}

// --- history ----------------------------------------------------------------

const HISTORY_FROM = '2024-01-08';
const HISTORY_TO = '2025-12-19';

function randomDay(r: Random, from: string, to: string): string {
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  return addDays(from, r.int(0, span));
}

/** One past visit on a day the provider actually worked, or null if none found. */
function pastVisit(r: Random, cat: Catalogue, diary: Diary, p: Patient, provider: Provider, typeId: string, near: string): Appointment | null {
  for (let tries = 0; tries < 20; tries++) {
    const date = randomDay(r, near, addDays(near, 60) > HISTORY_TO ? HISTORY_TO : addDays(near, 60));
    const cells = workingCells(cat, provider, date);
    if (cells.length === 0) continue;
    const cell = r.pick(cells);
    return diary.add(
      {
        patient_id: p.patient_id,
        provider_id: provider.id,
        location_id: cell.location,
        appointment_type_id: typeId,
        duration_minutes: cat.types.get(typeId)!.duration_minutes,
        date,
        minute: cell.minute,
      },
      false,
    );
  }
  return null;
}

function specialtiesFor(cat: Catalogue, p: Patient, on: string): string[] {
  return [...cat.specialties.keys()].filter((s) => eligible(cat, { ...p, referrals: [...p.referrals, 'dermatology', 'physiotherapy'] }, s, on));
}

/**
 * A history in one of the shapes the docs describe: a regular with one doctor,
 * a short course of treatment that stopped, or a scatter across specialties.
 */
function writeHistory(r: Random, cat: Catalogue, diary: Diary, p: Patient): void {
  if (!p.has_visited_before) return;
  const visits = r.weighted([[1, 3], [2, 3], [3, 2], [4, 2], [6, 1], [8, 1]] as const);
  let cursor = randomDay(r, HISTORY_FROM, '2025-06-30');
  const regular = r.chance(0.5);
  let specialty = r.pick(specialtiesFor(cat, p, cursor).length ? specialtiesFor(cat, p, cursor) : ['orthopaedics']);
  let provider = r.pick(cat.providersOf(specialty));
  const seen = new Set<string>();

  for (let i = 0; i < visits && cursor < HISTORY_TO; i++) {
    if (!regular && i > 0 && r.chance(0.5)) {
      const options = specialtiesFor(cat, p, cursor);
      if (options.length) specialty = r.pick(options);
      provider = r.pick(cat.providersOf(specialty));
    }
    const type = cat.typeFor(specialty, seen.has(specialty));
    if (pastVisit(r, cat, diary, p, provider, type.id, cursor)) seen.add(specialty);
    cursor = addDays(cursor, r.int(20, 120));
  }
}

// --- the note ---------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COUNT = ['', 'once', 'twice', 'three times', 'four times', 'five times', 'six times', 'seven times', 'eight times'];

function noteFor(cat: Catalogue, p: Patient, past: Appointment[]): string {
  const parts: string[] = [];
  if (past.length === 0) {
    parts.push('New to the clinic — no visits on record.');
  } else {
    const last = past[past.length - 1]!;
    const [y, m] = last.start_time.split('-');
    parts.push(`Not been in since ${MONTHS[Number(m) - 1]} ${y}.`);
    const doctors = new Set(past.map((a) => a.provider_id));
    const sites = new Set(past.map((a) => a.location_id));
    if (doctors.size === 1) {
      parts.push(`Seen ${COUNT[past.length] ?? `${past.length} times`}, by ${cat.providers.get(last.provider_id)!.name}.`);
    } else {
      const specs = [...new Set(past.map((a) => cat.providers.get(a.provider_id)!.specialty_name.toLowerCase()))];
      parts.push(`${past.length} visits across ${specs.join(', ')}, with no one regular doctor.`);
    }
    if (sites.size === 1) parts.push(`Every visit so far has been at ${cat.locations.get([...sites][0]!)!.name}.`);
  }
  if (p.manner) parts.push(p.manner);
  return parts.join(' ');
}

// --- the event calendar -----------------------------------------------------

/** How full each diary runs. The docs: the one gynaecologist is packed, the one physio has room. */
function fillTarget(r: Random, specialtyId: string): number {
  if (specialtyId === 'gynaecology') return 0.72;
  if (specialtyId === 'physiotherapy') return 0.4;
  return 0.45 + r.next() * 0.22;
}

function fillCalendar(r: Random, cat: Catalogue, diary: Diary, patients: Patient[]): void {
  const { starts, ends, closure_days } = cat.calendar;
  for (const provider of cat.raw.providers) {
    const target = fillTarget(r, provider.specialty_id);
    const types = cat.typesOf(provider);
    const pool = patients.filter((p) => eligible(cat, p, provider.specialty_id, starts) && p.patient_id > 'P00006');
    if (pool.length === 0) continue;

    for (const date of eachDay(starts, ends)) {
      if (closure_days.includes(date) || onLeave(provider, date)) continue;
      const cells = workingCells(cat, provider, date);
      let busy = 0;
      for (const cell of r.shuffle([...cells])) {
        if (busy >= target * cells.length) break;
        const p = r.pick(pool);
        const type = cat.typeFor(provider.specialty_id, p.has_visited_before);
        if (!types.has(type.id)) continue;
        const need = Math.ceil(type.duration_minutes / CELL);
        // The whole appointment has to fit inside this provider's cells at this site.
        const fits = Array.from({ length: need }, (_, i) => cell.minute + i * CELL)
          .every((m) => cells.some((c) => c.location === cell.location && c.minute === m));
        if (!fits || !diary.isFree(provider.id, date, cell.minute, need)) continue;
        diary.add(
          {
            patient_id: p.patient_id,
            provider_id: provider.id,
            location_id: cell.location,
            appointment_type_id: type.id,
            duration_minutes: type.duration_minutes,
            date,
            minute: cell.minute,
          },
          true,
        );
        busy += need;
      }
    }
  }
}

/**
 * The anchors' fixed history and calendar entries. Jorge's upcoming appointment is
 * placed a week ahead of whenever the mock boots, so "cancel my appointment" always
 * has something upcoming to cancel.
 */
function anchorDiary(cat: Catalogue, diary: Diary, today: string): Record<string, string> {
  const ids: Record<string, string> = {};
  const past = (patient: string, provider: string, location: string, type: string, date: string, minute: number): void => {
    diary.add({ patient_id: patient, provider_id: provider, location_id: location, appointment_type_id: type, duration_minutes: cat.types.get(type)!.duration_minutes, date, minute }, false);
  };

  // Marta: a regular of Dra. Ortiz at Centro.
  past(ANCHORS.marta, 'PR01', 'centro', 'first_visit', '2024-02-13', 600);
  past(ANCHORS.marta, 'PR01', 'centro', 'review', '2024-09-24', 555);
  past(ANCHORS.marta, 'PR01', 'centro', 'review', '2025-05-06', 615);
  // Jorge: orthopaedics, one visit behind him and one ahead.
  const ortho = cat.providersOf('orthopaedics')[0]!;
  const orthoSite = ortho.schedules[0]!.location_id;
  past(ANCHORS.jorge, ortho.id, orthoSite, 'orthopaedic_first_visit', '2025-03-11', 600);
  let day = addDays(today, 7);
  while (workingCells(cat, ortho, day).length === 0 || cat.calendar.closure_days.includes(day)) day = addDays(day, 1);
  const cell = workingCells(cat, ortho, day)[4] ?? workingCells(cat, ortho, day)[0]!;
  ids.jorgeUpcoming = diary.add({ patient_id: ANCHORS.jorge, provider_id: ortho.id, location_id: cell.location, appointment_type_id: 'orthopaedic_review', duration_minutes: 15, date: day, minute: cell.minute }, true).appointment_id;
  // Pilar, Antonio, Elena, Daniel: seen before, nothing ahead.
  past(ANCHORS.pilar, 'PR01', 'centro', 'first_visit', '2024-06-04', 660);
  past(ANCHORS.antonio, 'PR01', 'centro', 'first_visit', '2025-01-21', 570);
  past(ANCHORS.elena, 'PR01', 'centro', 'first_visit', '2024-11-05', 630);
  const paeds = cat.providersOf('paediatrics')[0]!;
  past(ANCHORS.daniel, paeds.id, paeds.schedules[0]!.location_id, 'paediatric_first_visit', '2025-02-18', 600);
  return ids;
}

export interface Diaries {
  diary: Diary;
  /** Ids the scenarios need to know, fixed per boot. */
  anchorAppointments: Record<string, string>;
}

export function writeDiaries(r: Random, cat: Catalogue, patients: Patient[], today: string): Diaries {
  const diary = new Diary(cat);
  const anchorAppointments = anchorDiary(cat, diary, today);
  for (const p of patients) if (p.patient_id > 'P00006') writeHistory(r, cat, diary, p);

  const history = (p: Patient): Appointment[] =>
    diary.forPatient(p.patient_id).filter((a) => a.start_time < '2026');
  // The record and the history must agree before any type is chosen from it:
  // nobody "seen before" has an empty history.
  for (const p of patients) if (history(p).length === 0) p.has_visited_before = false;

  fillCalendar(r, cat, diary, patients);
  for (const p of patients) p.note = noteFor(cat, p, history(p));
  return { diary, anchorAppointments };
}
