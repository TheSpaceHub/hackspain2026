import { voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import type { WebSocket } from 'ws';
import { GREETING, ReceptionistAgent } from './agent.js';
import { MediaStreamAudioInput } from './audio-input.js';
import { MediaStreamAudioOutput } from './audio-output.js';
import { writeCallLog, type CallLog } from './call-log.js';
import {
  acceptFromTranscript,
  createCallState,
  readCallState,
  recordMatch,
  type CallState,
} from './call-state.js';
import { createExtractor, type Extractor } from './extract.js';
import type { Availability, Catalogue, ClinicApi } from './clinic-api.js';
import { config } from './config.js';
import { FLOOR_ACTION, decide, type DeciderResult } from './decider.js';
import {
  applyEmergencyGuard,
  enforceAppointmentType,
  enforcePolicy,
  overrideFlooredBooking,
} from './guards.js';
import { mulawToPcm16 } from './mulaw.js';
import { callContext } from './log.js';
import { createLLM, createSTT, createTTS, type SharedVad } from './models.js';
import type { Action } from './schema.js';
import { submitActions, type SubmitResult } from './submit.js';
import type { Store } from './store/index.js';
import { buildCallTranscript, formatTranscript, type TranscriptTurn } from './transcript.js';
import { SAMPLE_RATE, type InboundMessage, type StartMessage } from './twilio.js';

/**
 * How long the close waits for the last exchange to be written down. Past it the
 * decider reads the transcript for that detail instead, which is slower but not wrong.
 */
const EXTRACT_SETTLE_MS = 4_000;

/** Everything deliberately shared across sockets, and nothing else. */
export interface Shared {
  vad: SharedVad;
  keyterms: string[];
  clinicBriefing: string;
  store: Store;
  /** Read-only lookups. One client, so the catalogue is fetched once for the process. */
  api: ClinicApi;
  /** Doctors, sites, plans and closures, parsed at boot. Null only if /clinic was down. */
  catalogue: Catalogue | null;
}

/**
 * One call, rooted in the connection handler and unreachable elsewhere. Everything the
 * call owns lives here; there is no module state in this file.
 */
export class CallSession {
  readonly #ws: WebSocket;
  readonly #shared: Shared;

  #callId = '';
  #streamSid = '';
  #fromNumber: string | undefined;

  #session: voice.AgentSession | null = null;
  #input: MediaStreamAudioInput | null = null;
  #output: MediaStreamAudioOutput | null = null;

  #startedAt = Date.now();
  #sessionStartMs: number | undefined;
  #closedAt: number | undefined;
  /** The submission window closes 30 s after the socket closes. */
  #deadlineAt = Number.POSITIVE_INFINITY;
  #wallClock: NodeJS.Timeout | null = null;

  #framesIn = 0;
  #framesOut = 0;
  #errors: string[] = [];
  #finishing: Promise<void> | null = null;
  #endedBy = 'unknown';
  #transcript: TranscriptTurn[] = [];
  #state: CallState | null = null;
  /** Fills the scratchpad off the turn, so note-taking costs the caller nothing. */
  #extractor: Extractor | null = null;
  /** The last availability answer, so the submitted type is the one the diary offered. */
  #availability: Availability | null = null;
  /** Turns already handed to the store, so a live flush never re-sends one. */
  #turnsWritten = 0;

  constructor(ws: WebSocket, shared: Shared) {
    this.#ws = ws;
    this.#shared = shared;

    ws.on('message', (data) => this.#onMessage(data));
    ws.on('close', () => {
      this.#closedAt = Date.now();
      this.#deadlineAt = this.#closedAt + config.submitWindowMs;
      void this.finish('socket_close');
    });
    ws.on('error', (err) => {
      this.#errors.push(`socket: ${String(err)}`);
    });
  }

  // --- wire ---------------------------------------------------------------

  #onMessage(data: unknown): void {
    if (this.#callId) callContext.enterWith(this.#callId);
    let msg: InboundMessage;
    try {
      msg = JSON.parse(String(data)) as InboundMessage;
    } catch {
      this.#errors.push('unparseable frame');
      return;
    }

    switch (msg.event) {
      case 'connected':
        break;
      case 'start':
        this.#onStart(msg as StartMessage);
        break;
      case 'media':
        this.#onMedia(msg as { media?: { payload?: string } });
        break;
      case 'stop':
        this.#endedBy = 'stop';
        // Close is imminent, so the window is at least this long.
        this.#deadlineAt = Math.min(this.#deadlineAt, Date.now() + config.submitWindowMs);
        void this.finish('stop');
        break;
      default:
        break;
    }
  }

  #onStart(msg: StartMessage): void {
    if (this.#callId) return;

    // start.callSid is the call_id; never mint one.
    this.#callId = msg.start?.callSid ?? msg.start?.streamSid ?? '';
    callContext.run(this.#callId, () => {
      this.#streamSid = msg.start?.streamSid ?? msg.streamSid ?? '';
      this.#fromNumber = msg.start?.customParameters?.from_number;
      this.#startedAt = Date.now();
      this.#state = createCallState(this.#callId, this.#fromNumber);
      this.#extractor = createExtractor({
        state: this.#state,
        onError: (message) => this.#errors.push(`extract: ${message}`),
      });

      // The line they rang from is a free directory query, and it resolves while the
      // greeting is still playing — often before they finish their first sentence.
      if (this.#state.from_number) this.#identifyByPhone(this.#state, this.#state.from_number);

      console.log(
        `[call ${this.#callId}] start · stream=${this.#streamSid} from=${this.#fromNumber ?? '(withheld)'}`,
      );

      this.#shared.store.write({
        type: 'call_started',
        call_id: this.#callId,
        stream_sid: this.#streamSid,
        from_number: this.#fromNumber,
        started_at: new Date(this.#startedAt).toISOString(),
      });

      // Never run past three minutes.
      this.#wallClock = setTimeout(() => {
        this.#endedBy = 'wall_clock';
        void this.finish('wall_clock');
      }, config.maxCallMs);

      void this.#startSession();
    });
  }

  #onMedia(msg: { media?: { payload?: string } }): void {
    const payload = msg.media?.payload;
    if (!payload || !this.#input) return;

    const mulaw = Buffer.from(payload, 'base64');
    const pcm = mulawToPcm16(mulaw);
    this.#input.push(new AudioFrame(pcm, SAMPLE_RATE, 1, pcm.length));
    this.#framesIn++;
  }

  #send = (data: string): void => {
    if (this.#ws.readyState !== this.#ws.OPEN) return;
    this.#ws.send(data);
    this.#framesOut++;
  };

  // --- conversation -------------------------------------------------------

  async #startSession(): Promise<void> {
    const t0 = Date.now();
    try {
      this.#input = new MediaStreamAudioInput();
      this.#output = new MediaStreamAudioOutput(this.#streamSid, this.#send);

      const session = new voice.AgentSession({
        vad: this.#shared.vad,
        stt: createSTT(this.#shared.keyterms),
        llm: createLLM(),
        tts: createTTS(),
        turnHandling: {
          // Unset, the session auto-provisions LiveKit's hosted turn detector.
          turnDetection: 'vad',
          endpointing: { minDelay: 400, maxDelay: 2500 },
          interruption: { enabled: true, minWords: 1 },
          preemptiveGeneration: { enabled: true },
        },
        // No room, so no echo path to warm up against.
        aecWarmupDuration: null,
        userAwayTimeout: null,
      });

      this.#session = session;
      session.input.audio = this.#input;
      session.output.audio = this.#output;

      // No room: the voice loop runs against our own transport.
      const agent = new ReceptionistAgent({
        state: this.#state ?? createCallState(this.#callId, this.#fromNumber),
        api: this.#shared.api,
        catalogue: this.#shared.catalogue,
        onAvailability: (availability) => {
          this.#availability = availability;
        },
      });
      await session.start({ agent });
      this.#sessionStartMs = Date.now() - t0;

      // Speak first: the harness cuts a call with no audible audio from us.
      session.say(GREETING, { allowInterruptions: true });

      // A turn lands in the store as soon as it is final, so a crash mid-call still
      // leaves the conversation on disk. The write crosses to the worker thread.
      session.on(voice.AgentSessionEventTypes.ConversationItemAdded, () => this.#flushTurns());
    } catch (err) {
      this.#errors.push(`session start: ${String(err)}`);
      console.error(`[call ${this.#callId}] session start failed: ${String(err)}`);
      // The call is lost; the submission is not.
      void this.finish('session_start_failed');
    }
  }

  /** Best-effort: a caller the directory knows by their own number needs no questions. */
  #identifyByPhone(state: CallState, phone: string): void {
    void this.#shared.api
      .findPatient({ phone })
      .then((matches) => {
        // Two people on one landline is a household, not an identification.
        if (matches.length === 1 && !state.matched) recordMatch(state, matches[0]!);
      })
      .catch((err: unknown) => this.#errors.push(`phone lookup: ${String(err)}`));
  }

  /** Hand the store every turn it has not seen yet. Cheap, and never throws into the call. */
  #flushTurns(): void {
    if (!this.#session || !this.#callId) return;
    let turns: TranscriptTurn[];
    try {
      turns = buildCallTranscript(this.#session.history);
    } catch {
      return;
    }
    const at = new Date().toISOString();
    for (let i = this.#turnsWritten; i < turns.length; i++) {
      const turn = turns[i]!;
      // Queued, not awaited: the agent is already answering this turn.
      if (turn.role !== 'assistant') {
        const before = turns[i - 1];
        this.#extractor?.observe(
          turn.text,
          before?.role === 'assistant' ? before.text : undefined,
        );
      }
      this.#shared.store.write({
        type: 'turn',
        call_id: this.#callId,
        seq: i,
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        text: turn.text,
        at,
      });
    }
    this.#turnsWritten = Math.max(this.#turnsWritten, turns.length);
  }

  // --- ending -------------------------------------------------------------

  /** Idempotent; reached from stop, socket close, the wall clock, or a failure. */
  finish(trigger: string): Promise<void> {
    this.#finishing ??= this.#finish(trigger);
    return this.#finishing;
  }

  async #finish(trigger: string): Promise<void> {
    if (this.#endedBy === 'unknown') this.#endedBy = trigger;
    if (this.#wallClock) clearTimeout(this.#wallClock);

    this.#input?.end();
    this.#output?.close();

    try {
      this.#transcript = this.#session ? buildCallTranscript(this.#session.history) : [];
    } catch (err) {
      this.#errors.push(`transcript: ${String(err)}`);
    }

    // Close before deciding: the 30 s clock starts at close.
    if (this.#ws.readyState === this.#ws.OPEN) {
      try {
        this.#ws.close();
      } catch {
        // already going
      }
    }
    this.#closedAt ??= Date.now();
    if (!Number.isFinite(this.#deadlineAt)) {
      this.#deadlineAt = this.#closedAt + config.submitWindowMs;
    }

    // Tear down alongside the decision: it talks to Deepgram and we owe it no window.
    const closing = this.#session
      ?.close()
      .catch((err: unknown) => this.#errors.push(`session close: ${String(err)}`));

    const budget = this.#deadlineAt - Date.now() - config.submitReserveMs;

    // The last exchange is usually still being written down when the caller hangs up,
    // and the decider reads the notes. Give it a slice of the window, not the window.
    this.#flushTurns();
    await this.#extractor?.settle(Math.max(0, Math.min(EXTRACT_SETTLE_MS, budget - 2_000)));

    // A slot the caller chose but the model never held: the ids are all in the quote.
    if (this.#state) {
      const inferred = acceptFromTranscript(this.#state, this.#transcript);
      if (inferred) this.#errors.push(`accepted slot inferred from the caller: ${inferred.start_time}`);
    }

    const decided = await decide(
      {
        callId: this.#callId,
        transcript: this.#transcript,
        fromNumber: this.#fromNumber,
        now: new Date(),
        clinicBriefing: this.#shared.clinicBriefing,
        callState: this.#state ? readCallState(this.#state) : undefined,
      },
      budget,
    );

    const actions = this.#guard(this.#actionsFor(decided));
    const submitStartedAt = Date.now();
    let submissions: SubmitResult[] = [];
    if (this.#callId) {
      submissions = await submitActions(this.#callId, actions);

      // A 422 records nothing at all, so a rejected body leaves the call with no record —
      // which scores exactly like never answering. Only 422 is worth retrying: 404 is the
      // wrong call_id and 410 is the closed window, and neither is fixed by a new body.
      const accepted = submissions.some((s) => s.ok);
      const malformed = submissions.some((s) => s.status === 422);
      const alreadyNoAction = actions.some((a) => a.action === 'no_action');
      if (!accepted && malformed && !alreadyNoAction && Date.now() < this.#deadlineAt - 1_000) {
        this.#errors.push(
          `submission rejected (${submissions.map((s) => `${s.action}=${s.status}`).join(' ')}); falling back to no_action`,
        );
        submissions = submissions.concat(await submitActions(this.#callId, [FLOOR_ACTION]));
      }
    } else {
      this.#errors.push('no call_id: never received a start message, nothing to submit against');
    }

    await closing;
    this.#flushTurns();
    this.#writeStore(decided, submissions, submitStartedAt);
    await this.#writeLog(decided, submissions, submitStartedAt);

    const verdict = submissions.map((s) => `${s.action}=${s.status}`).join(' ') || 'none';
    console.log(
      `[call ${this.#callId}] end (${this.#endedBy}) · turns=${this.#transcript.length} · ${verdict}`,
    );
  }

  /** Always yields at least one action. */
  #actionsFor(decided: DeciderResult): Action[] {
    if (decided.usedFloor) {
      this.#errors.push(`floor: ${decided.error ?? decided.output.notes ?? 'unknown'}`);
    }
    let actions = decided.output.actions;
    if (actions.length === 0) {
      this.#errors.push('decider returned no actions');
      actions = [FLOOR_ACTION];
    }
    if (this.#state) {
      const overridden = overrideFlooredBooking(actions, this.#state);
      if (overridden !== actions) {
        const reason = actions.find((action) => action.action === 'no_action')?.reason ?? 'unknown';
        this.#errors.push(
          `decider said no_action/${reason} with an accepted slot on file; booked from state`,
        );
        actions = overridden;
      }
    }
    return actions;
  }

  /**
   * Two things the model does not get a vote on: a red flag in the transcript outranks
   * whatever the call was about, and the appointment type is the one /availability chose
   * for this patient rather than the one that sounded right.
   */
  #guard(actions: Action[]): Action[] {
    const { actions: guarded, finding } = applyEmergencyGuard(
      actions,
      formatTranscript(this.#transcript),
    );
    if (finding) this.#errors.push(`emergency guard: ${finding.flag}`);

    const availability = this.#availability;
    const state = this.#state;
    return guarded.map((action) => {
      let fixed = action;
      if (fixed.action === 'book' && availability) {
        const typed = enforceAppointmentType(fixed, availability);
        if (typed.corrected) {
          this.#errors.push(`appointment type corrected to ${typed.action.appointment_type_id}`);
        }
        fixed = typed.action;
      }
      if ((fixed.action === 'book' || fixed.action === 'reschedule') && state) {
        const billed = enforcePolicy(fixed, state);
        if (billed.corrected) this.#errors.push(`policy corrected to ${billed.action.policy_id}`);
        fixed = billed.action;
      }
      return fixed;
    });
  }

  #writeStore(
    decided: DeciderResult,
    submissions: SubmitResult[],
    _submitStartedAt: number,
  ): void {
    if (!this.#callId) return;
    const endedAt = Date.now();
    this.#shared.store.write({
      type: 'call_ended',
      call_id: this.#callId,
      ended_at: new Date(endedAt).toISOString(),
      ended_by: this.#endedBy,
      call_ms: (this.#closedAt ?? endedAt) - this.#startedAt,
      frames_in: this.#framesIn,
      frames_out: this.#framesOut,
      session_start_ms: this.#sessionStartMs,
      decider_ms: decided.durationMs,
      close_to_submitted_ms: this.#closedAt ? endedAt - this.#closedAt : undefined,
      decider_model: config.provider === 'anthropic'
        ? config.anthropic.deciderModel
        : config.cloudflare.deciderModel,
      decider_raw: decided.raw,
      decider_notes: decided.output.notes,
      decider_conf: decided.output.confidence,
      used_floor: decided.usedFloor,
      errors: this.#errors,
    });
    for (const [i, s] of submissions.entries()) {
      this.#shared.store.write({
        type: 'submission',
        call_id: this.#callId,
        seq: i,
        action: s.action,
        route: s.route,
        body: JSON.stringify(s.body),
        status: s.status,
        response: s.response === undefined ? undefined : JSON.stringify(s.response),
        attempts: s.attempts,
        duration_ms: s.durationMs,
        error: s.error,
      });
    }
  }

  async #writeLog(
    decided: DeciderResult,
    submissions: SubmitResult[],
    submitStartedAt: number,
  ): Promise<void> {
    const endedAt = Date.now();
    const entry: CallLog = {
      call_id: this.#callId,
      stream_sid: this.#streamSid,
      from_number: this.#fromNumber,
      started_at: new Date(this.#startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      timings: {
        call_ms: (this.#closedAt ?? endedAt) - this.#startedAt,
        session_start_ms: this.#sessionStartMs,
        decider_ms: decided.durationMs,
        submit_ms: endedAt - submitStartedAt,
        close_to_submitted_ms: this.#closedAt ? endedAt - this.#closedAt : undefined,
      },
      audio: {
        frames_in: this.#framesIn,
        frames_out: this.#framesOut,
      },
      transcript: this.#transcript,
      notes: this.#state ? readCallState(this.#state) : undefined,
      decider: {
        input: {
          from_number: this.#fromNumber,
          now: new Date().toISOString(),
          turns: this.#transcript.length,
        },
        output: decided.output,
        raw: decided.raw,
        error: decided.error,
        used_floor: decided.usedFloor,
      },
      submissions,
      errors: this.#errors,
      ended_by: this.#endedBy,
    };
    await writeCallLog(entry);
  }
}
