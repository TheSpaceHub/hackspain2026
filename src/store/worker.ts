import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import type { CallEnded, CallStarted, Query, StoreMessage, SubmissionRow, TurnRow } from './protocol.js';
import { computeStats, type StatsRow } from './stats.js';

/**
 * The central store, on its own thread. node:sqlite is synchronous, and the main thread
 * paces 20ms audio frames for every live call — a write there would jitter all of them.
 * One writer, so WAL's single-writer rule is satisfied by construction.
 */

const db = new DatabaseSync((workerData as { path: string }).path);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous  = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS calls (
    call_id      TEXT PRIMARY KEY,
    stream_sid   TEXT,
    from_number  TEXT,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    ended_by     TEXT,
    call_ms      INTEGER,
    frames_in    INTEGER,
    frames_out   INTEGER,
    session_start_ms      INTEGER,
    decider_ms            INTEGER,
    close_to_submitted_ms INTEGER,
    decider_model TEXT,
    decider_raw   TEXT,
    decider_notes TEXT,
    decider_conf  REAL,
    used_floor    INTEGER NOT NULL DEFAULT 0,
    errors        TEXT
  );

  CREATE TABLE IF NOT EXISTS turns (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
    seq     INTEGER NOT NULL,
    role    TEXT NOT NULL,
    text    TEXT NOT NULL,
    at      TEXT NOT NULL,
    UNIQUE(call_id, seq)
  );
  CREATE INDEX IF NOT EXISTS turns_by_call ON turns(call_id, seq);

  CREATE TABLE IF NOT EXISTS submissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id     TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    action      TEXT NOT NULL,
    route       TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      INTEGER NOT NULL,
    response    TEXT,
    attempts    INTEGER,
    duration_ms INTEGER,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS submissions_by_call ON submissions(call_id, seq);
`);

const insertCall = db.prepare(
  `INSERT INTO calls (call_id, stream_sid, from_number, started_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(call_id) DO NOTHING`,
);
const insertTurn = db.prepare(
  `INSERT INTO turns (call_id, seq, role, text, at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(call_id, seq) DO UPDATE SET text = excluded.text`,
);
const endCall = db.prepare(
  `UPDATE calls SET ended_at=?, ended_by=?, call_ms=?, frames_in=?, frames_out=?,
     session_start_ms=?, decider_ms=?, close_to_submitted_ms=?, decider_model=?,
     decider_raw=?, decider_notes=?, decider_conf=?, used_floor=?, errors=?
   WHERE call_id=?`,
);
const insertSubmission = db.prepare(
  `INSERT INTO submissions (call_id, seq, action, route, body, status, response, attempts, duration_ms, error)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const recentCalls = db.prepare(
  `SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.call_id = c.call_id) AS turn_count,
          (SELECT group_concat(s.action || '=' || s.status) FROM submissions s WHERE s.call_id = c.call_id) AS outcome
   FROM calls c ORDER BY c.started_at DESC LIMIT ?`,
);
const oneCall = db.prepare(`SELECT * FROM calls WHERE call_id = ?`);
const callTurns = db.prepare(`SELECT seq, role, text, at FROM turns WHERE call_id = ? ORDER BY seq`);
const callSubs = db.prepare(`SELECT * FROM submissions WHERE call_id = ? ORDER BY seq`);
// One row per call for the overview; the aggregating happens in stats.ts.
const statsRows = db.prepare(
  `SELECT c.started_at, c.ended_at, c.call_ms, c.session_start_ms, c.decider_ms, c.close_to_submitted_ms, c.used_floor,
          (SELECT s.action FROM submissions s WHERE s.call_id = c.call_id AND s.status IN (200, 409)
            ORDER BY s.seq LIMIT 1) AS outcome,
          (SELECT COUNT(*) FROM submissions s WHERE s.call_id = c.call_id) AS submissions
   FROM calls c WHERE c.started_at >= ? ORDER BY c.started_at`,
);

/** A row the store cannot write must never take a call down with it. */
function guard(run: () => void): void {
  try {
    run();
  } catch (err) {
    console.error(`[store] write failed: ${String(err)}`);
  }
}

parentPort?.on('message', (msg: StoreMessage) => {
  switch (msg.type) {
    case 'call_started': {
      const m = msg as CallStarted;
      guard(() => insertCall.run(m.call_id, m.stream_sid ?? null, m.from_number ?? null, m.started_at));
      break;
    }
    case 'turn': {
      const m = msg as TurnRow;
      guard(() => insertTurn.run(m.call_id, m.seq, m.role, m.text, m.at));
      break;
    }
    case 'call_ended': {
      const m = msg as CallEnded;
      guard(() =>
        endCall.run(
          m.ended_at, m.ended_by, m.call_ms, m.frames_in, m.frames_out,
          m.session_start_ms ?? null, m.decider_ms ?? null, m.close_to_submitted_ms ?? null,
          m.decider_model ?? null, m.decider_raw ?? null, m.decider_notes ?? null,
          m.decider_conf ?? null, m.used_floor ? 1 : 0, JSON.stringify(m.errors), m.call_id,
        ),
      );
      break;
    }
    case 'submission': {
      const m = msg as SubmissionRow;
      guard(() =>
        insertSubmission.run(m.call_id, m.seq, m.action, m.route, m.body, m.status,
          m.response ?? null, m.attempts, m.duration_ms, m.error ?? null),
      );
      break;
    }
    case 'query': {
      const m = msg as Query;
      try {
        const rows =
          m.name === 'recent'
            ? recentCalls.all(m.limit ?? 50)
            : m.name === 'stats'
              ? computeStats(
                  statsRows.all(m.since ?? '') as unknown as StatsRow[],
                  m.since ?? null,
                  m.bucket_ms ?? 3_600_000,
                  Date.now(),
                )
              : {
                  call: oneCall.get(m.call_id ?? ''),
                  turns: callTurns.all(m.call_id ?? ''),
                  submissions: callSubs.all(m.call_id ?? ''),
                };
        parentPort?.postMessage({ type: 'query_result', id: m.id, rows });
      } catch (err) {
        parentPort?.postMessage({ type: 'query_result', id: m.id, rows: null, error: String(err) });
      }
      break;
    }
  }
});
