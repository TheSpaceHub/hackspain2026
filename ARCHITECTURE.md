# Architecture

## The shape

```
                    ┌──────────────────────────────────────┐
  Prosper harness   │            one Node process          │
   (wss, 10–20      │                                      │
    sockets)        │   ws server ──┬── CallSession  ──┐   │
        │           │               ├── CallSession  ──┤   │
        └──────────▶│               ├── CallSession  ──┤   │
                    │               └── …             ──┤   │
                    │                                   ▼   │
                    │                            central store
                    │                        (single writer, SQLite/WAL)
                    │                                   │   │
                    └───────────────────────────────────┼───┘
                                                        ▼
                                                  calls.db
```

**One thread of control per call.** Each socket gets a `CallSession` holding its own
`AgentSession`, agent, audio in/out, STT/TTS streams, transcript, `call_id`, `streamSid`,
timers, decider call and submission. It is created in the connection handler and
unreachable from anywhere else.

**No call data is shared between calls.** What *is* shared is infrastructure, deliberately
and read-only: the Silero VAD weights, the clinic catalogue (generated once, identical all
event) and the stateless submit client. `grep -n "^let \|^var " src/*.ts` should only ever
show write-once memoisation.

**One central store, one writer.** Calls hand rows to the store; the store owns the file.

## Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous  = NORMAL;

CREATE TABLE calls (
  call_id        TEXT PRIMARY KEY,   -- start.callSid, never minted
  stream_sid     TEXT,
  from_number    TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  ended_by       TEXT,               -- stop | socket_close | wall_clock | …
  call_ms        INTEGER,
  frames_in      INTEGER,
  frames_out     INTEGER,
  session_start_ms       INTEGER,
  decider_ms             INTEGER,
  close_to_submitted_ms  INTEGER,    -- the 30s window, measured
  decider_model  TEXT,
  decider_raw    TEXT,
  decider_notes  TEXT,
  decider_conf   REAL,
  used_floor     INTEGER NOT NULL DEFAULT 0,
  errors         TEXT                -- JSON array
);

CREATE TABLE turns (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id   TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  role      TEXT NOT NULL,           -- user | assistant
  text      TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX turns_by_call ON turns(call_id, seq);

CREATE TABLE submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id      TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,     -- a call may post more than once
  action       TEXT NOT NULL,        -- book | register | … | no_action
  route        TEXT NOT NULL,
  body         TEXT NOT NULL,        -- JSON, exactly as sent
  status       INTEGER NOT NULL,     -- 200 | 409 | 410 | 422 | 404 | 0
  response     TEXT,
  attempts     INTEGER,
  duration_ms  INTEGER,
  error        TEXT
);
CREATE INDEX submissions_by_call ON submissions(call_id, seq);
```

`node:sqlite` (`DatabaseSync`) is built into Node 24 — no native dependency.

## Writes never touch the call path

`node:sqlite` is synchronous, and the main thread paces one 20 ms audio frame per live
call. A write there would jitter every call at once, not just its own. So the store runs in
a **worker thread**: `CallSession` does a fire-and-forget `postMessage` and returns
immediately. The worker is the only writer, which is what WAL actually requires — WAL gives
many readers alongside *one* writer, it does not make writes concurrent.

Turns are written as they finalise (`ConversationItemAdded`), so a crash mid-call still
leaves the conversation on disk. The JSONL line is still appended at end of call, as an
append-only backup that survives a database problem.

## Reading it

| Route | What it gives |
| --- | --- |
| `GET /health` | liveness, plus the number of calls in progress |
| `GET /calls?limit=n` | recent calls, newest first, with turn counts and outcomes |
| `GET /calls/<call_id>` | one call: its row, every turn, every submission |
| `GET /events` | **SSE stream** — one event per row, at the moment it is written |

`/events` is for a realtime dashboard: `new EventSource("http://host:7860/events")` in the
browser, no dependency and no polling. Event names are the row types — `call_started`,
`turn`, `call_ended`, `submission` — plus `hello` on connect and a 15 s `heartbeat`
carrying the live call count, which also keeps tunnels from dropping an idle stream.
All read routes send `Access-Control-Allow-Origin: *` so the dashboard can be served
from anywhere.
