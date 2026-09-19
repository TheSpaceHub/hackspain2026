/**
 * The clinic on disk. One SQLite file (node:sqlite, like calls.db) holds the snapshot
 * taken from the live API and everything calls have done to it since. The process is
 * the only writer, so a synchronous connection is enough and every mutation is one
 * transaction — two calls booking the same cells serialise here, not in the agent.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  -- one row per snapshot: the /clinic body verbatim, plus where and when it came from
  CREATE TABLE IF NOT EXISTS snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source TEXT NOT NULL,
    taken_at INTEGER NOT NULL,
    clinic_json TEXT NOT NULL,
    openapi_json TEXT
  );

  -- source = 'prosper' (copied from the directory) | 'local' (REGISTERed here)
  CREATE TABLE IF NOT EXISTS patients (
    patient_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS patients_source ON patients(source);

  -- status = 'active' | 'cancelled'; source = 'prosper' | 'local'
  CREATE TABLE IF NOT EXISTS appointments (
    appointment_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    patient_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    appointment_type_id TEXT NOT NULL,
    start_time TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    call_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS appointments_patient ON appointments(patient_id);

  -- the calendar itself: one row per busy 15-minute cell. ref is the appointment, or
  -- 'snapshot' for cells the live API showed as taken with nobody we know in them.
  CREATE TABLE IF NOT EXISTS cells (
    provider_id TEXT NOT NULL,
    date TEXT NOT NULL,
    minute INTEGER NOT NULL,
    ref TEXT NOT NULL,
    PRIMARY KEY (provider_id, date, minute)
  );
  -- what the calendar looked like the moment the snapshot was taken; reset copies it back
  CREATE TABLE IF NOT EXISTS snapshot_cells (
    provider_id TEXT NOT NULL,
    date TEXT NOT NULL,
    minute INTEGER NOT NULL,
    PRIMARY KEY (provider_id, date, minute)
  );

  -- the per-patient plan rules the live API only reveals in 'blocked'
  CREATE TABLE IF NOT EXISTS plan_rules (
    patient_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    specialty_id TEXT NOT NULL,
    restriction TEXT,
    PRIMARY KEY (patient_id, plan, specialty_id)
  );

  -- a call's claim on cells while the caller decides. Gone at expires_at, or when the
  -- call books, releases, or submits anything.
  CREATE TABLE IF NOT EXISTS holds (
    hold_id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    appointment_type_id TEXT NOT NULL,
    patient_id TEXT,
    start_time TEXT NOT NULL,
    date TEXT NOT NULL,
    minute INTEGER NOT NULL,
    cells INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS holds_call ON holds(call_id);
  CREATE INDEX IF NOT EXISTS holds_cell ON holds(provider_id, date);

  CREATE TABLE IF NOT EXISTS calls (
    call_id TEXT PRIMARY KEY,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    from_number TEXT,
    scenario TEXT,
    last_received_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL,
    action_json TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS actions_call ON actions(call_id);

  -- everything that happened, in order, so a late listener can catch up (?since=)
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    call_id TEXT,
    data_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`;

export type Row = Record<string, SQLInputValue>;

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside a transaction; nested calls join the outer one. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** A monotonic counter kept in the file, so ids survive restarts. */
export function nextCounter(db: DatabaseSync, name: string): number {
  db.prepare(
    `INSERT INTO counters(name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
  ).run(name);
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number };
  return row.value;
}
