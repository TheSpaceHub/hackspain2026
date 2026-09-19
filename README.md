# El Turno — voice agent v0

HackSpain '26 · Prosper track · headless LiveKit Agents + Cloudflare Workers AI

A phone call that works end to end and **submits something every time**. The Prosper
harness dials our socket, a persona talks to us for up to three minutes, and within
30 seconds of the socket closing we have POSTed an action.

This is v0 deliberately. There are **no clinic lookups during the call** — the agent
talks from a system prompt alone, so it cannot quote a real slot and will fail most
cases on the record. That is accepted. The point is that the pipeline never returns
silence, which the scoring page calls out as always wrong and never cheaper than a
wrong answer.

## Architecture

One Node process, one WebSocket server, one headless `AgentSession` per socket. No
LiveKit server, no SIP, no rooms.

The unlock is that `AgentSession.start({ agent, room? })` takes `room` as optional, and
`session.input.audio` / `session.output.audio` accept custom `AudioInput` / `AudioOutput`
subclasses. So the whole LiveKit voice loop — VAD, endpointing, preemptive generation,
interruption, the STT/LLM/TTS plumbing — runs against our own audio transport.

```
Prosper harness  ──wss, Twilio Media Streams──▶  ws server
                                                    │ one per socket
                                                    ▼
                                               CallSession
                                    ┌───────────────┴───────────────┐
                        MediaStreamAudioInput           MediaStreamAudioOutput
                                    └───────────────┬───────────────┘
                                                    ▼
                                            LiveKit AgentSession
                                          (Deepgram / Workers AI)
                                                    │ on stop
                                                    ▼
                                                 Decider
                                                    │
                                                    ▼
                                        POST /api/v1/submit/*
```

| File | What it owns |
| --- | --- |
| `src/index.ts` | Boot: VAD, catalogue, WebSocket server, one `CallSession` per connection |
| `src/call-session.ts` | **One call.** The whole per-socket object graph and the ending |
| `src/audio-input.ts` | µ-law frames off the wire into the session |
| `src/audio-output.ts` | Session audio out, paced at 20 ms, with local barge-in |
| `src/mulaw.ts` | G.711 µ-law ↔ PCM16, table-driven both ways |
| `src/twilio.ts` | The wire message shapes |
| `src/agent.ts` | One `Agent`, one system prompt, zero tools |
| `src/models.ts` | Deepgram STT/TTS, Workers AI LLM, shared Silero VAD |
| `src/clinic.ts` | Catalogue fetched once, cached forever, turned into STT keyterms |
| `src/decider.ts` | Transcript → one action, with a floor that always produces one |
| `src/schema.ts` | The Zod discriminated union and the closed reason vocabulary |
| `src/submit.ts` | Six routes, one action each |
| `src/call-log.ts` | One JSON line per call — the v1 evaluation harness |

## Run book

```bash
pnpm install
cp .env.example .env     # fill in the four keys
pnpm dev                 # listens on :7860, path /ws
```

Check the key and the clinic **before** touching audio:

```bash
curl -sS "$PROSPER_API_BASE_URL/api/v1/health"
curl -sS -H "X-Api-Key: $PROSPER_API_KEY" \
  "$PROSPER_API_BASE_URL/api/v1/directory?name=Marta%20Ruiz"
```

Expose it with a claimed static domain, in a European region — audio is 20 ms frames
and a transatlantic hop taxes every one:

```bash
ngrok http --url=our-team.ngrok-free.app 7860
wscat -c wss://our-team.ngrok-free.app/ws    # must connect before handing it over
```

Then set the endpoint **yourself**, on the dashboard under **Settings → Integration**.
The desk does not do this and every team starts on a placeholder. The value is
`wss://our-team.ngrok-free.app/ws` — **scheme and path included**; forgetting the path
is the commonest mistake in the docs' own words. Saving replaces the whole
configuration, and a run snapshots its endpoint when it is admitted, so a queued run
still dials the old one.

**First call.** Problems → problem 1 → *Call* beside a published case. Practice scores
nothing, gives you the transcript, the recording and which fields your record lost, and
is rate-limited to one per 30 seconds. Debug here; never spend a Run All on debugging.

**Run All discipline.** One queued or active run at a time, 15 minutes of cooldown after
the last finished, about 18 minutes per run — roughly one every 33 minutes. The
leaderboard takes your **best** run, not the latest, so a bad experiment costs nothing
but the slot.

## Testing locally

`test/fake-harness.ts` is a stand-in for the Prosper harness: it dials your own `/ws`
speaking the same Twilio Media Streams messages, plays a scripted caller at 20 ms per
frame (synthesised with `say` on macOS, `espeak-ng` on Linux — `dnf install espeak-ng`;
without either the caller is silent), records what the agent says back to a WAV, and
reports the timings. Use it instead of practice calls, which are rate-limited.

```bash
pnpm harness                       # one scripted booking call
pnpm harness -- --n 10             # ten concurrent calls — the Run All shape
pnpm harness -- --n 20             # the Switchboard burst
pnpm harness -- --barge-in         # talk over the greeting
pnpm harness -- --wav caller.wav   # play a real recording instead
pnpm harness -- --say "line one" --say "line two"
```

It fails loudly if any call produced no agent audio, which is the failure the harness
attributes to us and cuts the call for.

```bash
pnpm test:audio    # pacing and barge-in, no network needed
pnpm typecheck
```

### A local Prosper

`mock/` is the Prosper platform API on your own machine: the same routes, bodies,
errors and 30-second submission window, over an invented clinic. Point the agent at it
and nothing leaves the machine but the agent's own model calls — no practice-call rate
limit, no Run All, no records on the real board.

```bash
pnpm mock                                   # the API on :8787, control routes on /__mock
pnpm start:local                            # the agent, submitting to the mock
pnpm harness:local -- --scenario simple     # one local case, graded PASS/FAIL
pnpm harness:local -- --scenario all        # every case at once
```

- **The catalogue is real, the people are not.** Sites, doctors, schedules, plans and
  rules are a snapshot of the real `/api/v1/clinic` (`mock/world/catalogue.json`),
  because the decider's prompt hard-codes facts about them. Patients, notes, visit
  histories and diaries are invented from a seed — the same 800 patients on every
  machine (`MOCK_SEED`, `MOCK_PATIENTS`).
- **Two plan rules are invented**, since the catalogue names them without saying which
  plan does what: which insurer demands its own referral, and which plans cap visits.
  Both are in `mock/world/catalogue.ts`.
- **Local cases** live in `mock/world/scenarios.ts`: a script, the caller id, and the
  record that should come out — simple booking, new patient, cancel, a rule refusal,
  a red flag, a privacy attempt, a parent booking for a child. `GET /__mock/scenarios`
  lists them. The caller is a fixed script, not a persona: it does not listen, so these
  test the pipeline and the record, not the conversation.
- **Grading is binary**, as on the board: the record matches the expectation exactly or
  the case fails, and a FAIL names the field that lost.
- A call the harness never announced gets the real API's 404. `MOCK_ACCEPT_ANY_CALL=1`
  accepts any `call_id`, for driving the agent from something other than the harness.

### A shared clinic

The mock gives every call a fresh, identical clinic. `sim/` is one clinic that all the
calls share and change: a copy of the real Prosper clinic taken at first boot, kept in
SQLite (`sim/data/clinic.db`) so it survives restarts, and mutated by what the calls
submit — a BOOK takes the cells, a RESCHEDULE moves them, a CANCEL frees them, a
REGISTER puts the patient in the directory — so the next call's `/availability` sees it.

```bash
pnpm sim                                    # the API on :8788, sim routes on /__sim
pnpm start:sim                              # the agent, holding slots on the sim
pnpm harness:sim -- --n 3                   # three concurrent callers on the one diary
curl -X POST localhost:8788/__sim/reset     # back to the snapshot (?resnapshot=1 re-copies)
curl -N localhost:8788/__sim/events?since=0 # every hold, release, booking… as SSE
```

- **The copy is what the API will show.** The catalogue verbatim; the calendar's
  occupancy by sweeping every provider's availability (a cell they work but do not
  offer is busy — nameless, but taken); patients only as `/directory` can find them,
  copied in with their appointments the first time a call asks. Needs `PROSPER_API_KEY`
  for the first boot and for live lookups; after that the file is enough.
- **Holds are how the calls coordinate.** `POST /__sim/holds` reserves a slot for a
  `call_id` (two minutes, `SIM_HOLD_TTL_MS`); other calls stop seeing it in
  `/availability` and get a 409 booking it, while the holder still sees its own. A
  submission decides the call's holds; the rest expire. Requests carry the call in
  `X-Sim-Call-Id` (or `?call_id=`), which is what tells "another call" from "me".
- **`SIM_HOLDS=1` is the agent's opt-in** (`src/sim-holds.ts`): `accept_slot` takes a
  hold before confirming the time, and a refusal sends the model back to `find_slots`.
  Unset, nothing in `src/` changes.
- Bookings and holds are checked and written in one SQLite transaction, so two calls
  landing on the same cell at the same instant cannot both win.
- `test/sim.test.ts` covers the diary, the holds, the window, persistence and the SSE
  stream against the bundled catalogue and a fixed clock; `pnpm test:sim`.

### Reading the call log

One JSON line per call in `$LOG_DIR`. This is the v1 evaluation harness and the seed of
everything the jury marks that the leaderboard cannot reach.

```bash
# did every call submit, and how late?
python3 -c "import json,glob;[print(r['call_id'], r['submissions'][0]['status'], \
  r['timings']['close_to_submitted_ms'],'ms') for f in glob.glob('calls/*.jsonl') for r in map(json.loads,open(f))]"
```

## Verified behaviour

Checked against `@livekit/agents` 1.9.0 on this build:

- **Pacing.** One 160-byte frame per 20 ms, not a burst — 5 frames at 100 ms, 26 at
  500 ms. An unpaced flush makes barge-in impossible, because the audio the caller is
  interrupting has already left.
- **Barge-in is ours.** The harness implements no server-side barge-in and says `clear`
  has no effect on its side today, so `clearBuffer()` drops our own queued frames
  locally and stops sending. We send `clear` anyway — free, and may start working.
- **Ten concurrent sockets** each hold their own `call_id`, `streamSid`, `from_number`,
  transcript and submission, and each POSTs under its own id exactly once, ~100 ms after
  close against a 30 s window.
- **The floor holds.** With the model stack deliberately broken, every call still POSTed
  an accepted `no_action`. Submitting nothing scores identically to a crash.
- **G.711** round-trips at 36.6 dB SNR, and `0xFF` ↔ digital zero.
- **Model split by role**, measured time-to-first-token on the real system prompt:
  llama-3.3-70b **427ms**, deepseek-v4-flash 1968ms, glm-5.3 1989ms, deepseek-v4-pro
  **2151ms**, glm-5.3-flash 4991ms. On a call that gap is dead air the caller talks over —
  at 2.1s the agent answered one turn in four. So the call runs llama-3.3-70b and the
  decider, which is offline with 24s of budget, runs deepseek-v4-pro. Both are one env var.
  (`kimi-k2.6` returns no assistant content over the OpenAI-compatible surface; unusable here.)
- **The frontier models are plan-gated, not credit-gated.** Workers AI 403s them on the Free
  plan regardless of Startup credit balance; Workers Paid unlocks them, and unlock
  propagates per-model over several minutes.
- **Deepgram loop**, with live keys: Aura-2 → our transport → nova-3 returns
  9.7 s of speech as 486 frames and transcribes it, with `Arenal Norte` and `Adeslas`
  both recovered by the keyterm list.
- **A whole call**, all four keys live: greeting at 883 ms, the agent elicits who is
  calling, reads a DNI back digit by digit, confirms the request, and the decider returns
  a valid action that is POSTed inside the window.

### Known for v1

`numerals: true` returns a DNI as spaced digits — `"2 4 8 2 4 6 1 0 c"`, not
`"24824610C"`. v0 never submits a `national_id`, but `register` and the directory lookup
both compare it exactly and re-derive its check letter, so whitespace stripping and
upper-casing belong in the first v1 commit.

## Deliberately not in v0

Any clinic lookup during the call, the flow graph, multi-action calls, languages beyond
English, the nearest-site geometry, a console of our own, recordings.

Because of that, v0 emits `no_action` on almost every call: with no lookups there is no
`patient_id` to book against and no real slot. Two endings it can genuinely get right
today are a published red-flag symptom → `escalate(medical_emergency)`, and an injection
attempt, sales call or request for someone else's data → `no_action(out_of_scope)`.

The submission client takes an **array** of actions from day one, so problem 18
(multi-action calls) needs no rewrite.

## Notes and traps

- **TTS must be `linear16`, not `mulaw`**, despite µ-law being the wire format. The
  Deepgram plugin pipes response bytes straight into an `AudioByteStream` that always
  reads them as PCM16 — it never decodes µ-law, so asking for mulaw yields noise at half
  duration. `MediaStreamAudioOutput` does the µ-law encoding instead. Verified at 1.9.0.
- `stt.SpeechEventType` is a **numeric** enum. Comparing it to a string silently matches
  nothing, which looks exactly like an STT that heard nothing.
- **Workers AI rejects `tools: []`** — "must not be an empty array. Either provide at
  least one tool or omit the field entirely." The plugin sends it on every turn when the
  agent has no tools, which in v0 is always, so every reply 400'd and the session closed
  on an unrecoverable LLM error. `createLLM` injects an OpenAI client whose `fetch`
  strips the empty array; it becomes a no-op the moment v1 adds real tools. The `openai`
  package must stay pinned to the version the plugin resolves, or the `client` option
  fails to typecheck.
- A caller's line is **always sending**, silence included. STT endpointing needs to hear
  that silence to close an utterance, so the fake harness streams continuously rather
  than only while the caller talks — and `utteranceEndMs` is set as a second net.
- `openai.LLM`, **never** `openai.responses.LLM` — Workers AI speaks chat completions,
  not the Responses API.
- `turnDetection: 'vad'` is set explicitly. Left unset, the session auto-provisions
  LiveKit's hosted turn detector, which we have no credentials for.
- `initializeLogger()` must be called at boot. Its CLI worker normally does this; we do
  not run that worker, and without it every plugin throws on first use.
- `/submit/*` JSON is plain snake_case. camelCase applies only to the Twilio-shaped
  handshake — where `sequenceNumber`, `chunk` and `timestamp` are **strings**.
- The `call_id` is exactly `start.callSid`. Never mint one.
- `no_action` posts to `/submit/no-action` — hyphen, not underscore.
- 409 is a retry landing twice, not a bug. 410 is the closed window and is never retried.
- The only things shared across sockets are the Silero VAD model, the clinic catalogue
  and the stateless submit client. `grep -n "^let \|^var " src/*.ts` should only ever
  show write-once memoisation
