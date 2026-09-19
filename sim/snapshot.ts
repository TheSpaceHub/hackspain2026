/**
 * The copy taken at instantiation. The live API is read-only and has no "list
 * everything" routes, so the copy is exactly what it will show:
 *
 * - the catalogue, verbatim (/clinic and the OpenAPI schema);
 * - the calendar's occupancy: every provider's free slots across the whole calendar,
 *   inverted against their working hours — a cell they work but do not offer is
 *   taken. Nobody's name is on those cells; they are simply busy;
 * - patients, only as /directory can find them: none up front, each copied in with
 *   their diary the first time a call asks for them (see Clinic.directory).
 */
import type { DatabaseSync } from 'node:sqlite';
import { addDays, eachDay, madridParts, toInstant } from '../mock/rules/time.js';
import { Catalogue } from '../mock/world/catalogue.js';
import { onLeave, workingCells } from '../mock/world/diary.js';
import { CELL } from './clinic.js';
import { transaction } from './db.js';
import type { ClinicBody, ProsperClient } from './prosper.js';

export interface SnapshotReport {
  source: string;
  taken_at: number;
  providers: number;
  busy_cells: number;
  requests: number;
}

/** Write a clinic body (and the busy cells already known) as the snapshot. */
export function writeSnapshot(
  db: DatabaseSync,
  source: string,
  clinic: ClinicBody,
  openapi: unknown,
  busy: { provider_id: string; date: string; minute: number }[],
  takenAt = Date.now(),
): void {
  transaction(db, () => {
    db.exec(`
      DELETE FROM snapshot; DELETE FROM snapshot_cells; DELETE FROM cells; DELETE FROM holds; DELETE FROM calls;
      DELETE FROM actions; DELETE FROM patients; DELETE FROM appointments; DELETE FROM plan_rules; DELETE FROM counters;
    `);
    db.prepare('INSERT INTO snapshot(id, source, taken_at, clinic_json, openapi_json) VALUES (1, ?, ?, ?, ?)').run(
      source,
      takenAt,
      JSON.stringify(clinic),
      openapi === null || openapi === undefined ? null : JSON.stringify(openapi),
    );
    const snap = db.prepare('INSERT OR IGNORE INTO snapshot_cells(provider_id, date, minute) VALUES (?, ?, ?)');
    const cell = db.prepare(`INSERT OR IGNORE INTO cells(provider_id, date, minute, ref) VALUES (?, ?, ?, 'snapshot')`);
    for (const b of busy) {
      snap.run(b.provider_id, b.date, b.minute);
      cell.run(b.provider_id, b.date, b.minute);
    }
    db.prepare('INSERT INTO events(at, type, call_id, data_json) VALUES (?, ?, NULL, ?)').run(
      takenAt,
      'snapshot',
      JSON.stringify({ source, providers: clinic.providers.length, busy_cells: busy.length }),
    );
  });
}

/**
 * Sweep the live calendar. One availability call per provider per 14-day window
 * (the API's maximum span), with no patient and no insurer so nothing is filtered
 * but the diary itself.
 */
export async function sweepOccupancy(
  live: ProsperClient,
  clinic: ClinicBody,
  log: (line: string) => void = () => {},
): Promise<{ busy: { provider_id: string; date: string; minute: number }[]; requests: number }> {
  const cat = new Catalogue(clinic);
  const { starts, ends, max_span_days, closure_days } = cat.calendar;
  const busy: { provider_id: string; date: string; minute: number }[] = [];
  let requests = 0;

  const windows: [string, string][] = [];
  for (let from = starts; from <= ends; from = addDays(from, max_span_days + 1)) {
    const to = addDays(from, max_span_days) > ends ? ends : addDays(from, max_span_days);
    windows.push([from, to]);
  }

  for (const provider of clinic.providers) {
    const free = new Set<string>();
    for (const [from, to] of windows) {
      const res = await live.availability({ date_from: from, date_to: to, provider_id: provider.id });
      requests++;
      // A slot is offered only where the whole visit fits, so every cell it spans is free.
      for (const s of res.slots) {
        const { date, minutes } = madridParts(toInstant(s.start_time));
        for (let i = 0; i < Math.ceil(s.duration_minutes / CELL); i++) free.add(`${date}|${minutes + i * CELL}`);
      }
    }
    let taken = 0;
    for (const date of eachDay(starts, ends)) {
      if (closure_days.includes(date) || onLeave(provider, date)) continue;
      for (const c of workingCells(cat, provider, date)) {
        if (free.has(`${date}|${c.minute}`)) continue;
        busy.push({ provider_id: provider.id, date, minute: c.minute });
        taken++;
      }
    }
    log(`${provider.id} ${provider.name}: ${free.size} free cells, ${taken} busy`);
  }
  return { busy, requests };
}

/** Copy the live clinic into `db`. */
export async function snapshotFromLive(db: DatabaseSync, live: ProsperClient, log: (line: string) => void = () => {}): Promise<SnapshotReport> {
  log(`snapshot: reading ${live.baseUrl} …`);
  const clinic = await live.clinic();
  let openapi: unknown = null;
  try {
    openapi = await live.openapi();
  } catch (err) {
    log(`snapshot: openapi not copied: ${String(err)}`);
  }
  log(`snapshot: ${clinic.clinic_name} — ${clinic.providers.length} providers, ${clinic.patient_count} patients, ${clinic.calendar.appointment_count} appointments`);
  const { busy, requests } = await sweepOccupancy(live, clinic, log);
  const taken_at = Date.now();
  writeSnapshot(db, live.baseUrl, clinic, openapi, busy, taken_at);
  log(`snapshot: ${busy.length} busy cells from ${requests + 2} requests`);
  return { source: live.baseUrl, taken_at, providers: clinic.providers.length, busy_cells: busy.length, requests: requests + 2 };
}
