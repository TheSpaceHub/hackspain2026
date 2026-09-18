import { voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import type { WebSocket } from 'ws';
import { GREETING, ReceptionistAgent } from './agent.js';
import { MediaStreamAudioInput } from './audio-input.js';
import { MediaStreamAudioOutput } from './audio-output.js';
import { writeCallLog, type CallLog } from './call-log.js';
import { config } from './config.js';
import { FLOOR_ACTION, decide, type DeciderResult } from './decider.js';
import { mulawToPcm16 } from './mulaw.js';
import { createLLM, createSTT, createTTS, type SharedVad } from './models.js';
import type { Action } from './schema.js';
import { submitActions, type SubmitResult } from './submit.js';
import { buildCallTranscript, type TranscriptTurn } from './transcript.js';
import { SAMPLE_RATE, type InboundMessage, type StartMessage } from './twilio.js';

/** Everything deliberately shared across sockets, and nothing else. */
export interface Shared {
  vad: SharedVad;
  keyterms: string[];
}

/**
 * One call. Created in the connection handler, rooted there, and unreachable from
 * anywhere else — the AgentSession, the agent, both audio ends, the STT and TTS
 * streams, the transcript, the call_id, the streamSid, the timers, the decider
 * call and the submission all live here.
 *
 * A module-level `let currentCall` is the bug this challenge looks for: it passes
 * every single-call test and fails every burst. There is no module state in this
 * file.
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
        // The socket close is imminent; the window is at least this long.
        this.#deadlineAt = Math.min(this.#deadlineAt, Date.now() + config.submitWindowMs);
        void this.finish('stop');
        break;
      default:
        break;
    }
  }

  #onStart(msg: StartMessage): void {
    if (this.#callId) return;

    // start.callSid is the call_id. Never mint one.
    this.#callId = msg.start?.callSid ?? msg.start?.streamSid ?? '';
    this.#streamSid = msg.start?.streamSid ?? msg.streamSid ?? '';
    this.#fromNumber = msg.start?.customParameters?.from_number;
    this.#startedAt = Date.now();

    console.log(
      `[call ${this.#callId}] start · stream=${this.#streamSid} from=${this.#fromNumber ?? '(withheld)'}`,
    );

    // Never let a call run past three minutes.
    this.#wallClock = setTimeout(() => {
      this.#endedBy = 'wall_clock';
      void this.finish('wall_clock');
    }, config.maxCallMs);

    void this.#startSession();
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
          // Explicit: left unset, the session auto-provisions LiveKit's hosted
          // turn detector, which we have no credentials for.
          turnDetection: 'vad',
          endpointing: { minDelay: 400, maxDelay: 2500 },
          interruption: { enabled: true, minWords: 1 },
          preemptiveGeneration: { enabled: true },
        },
        // There is no room and therefore no echo path to warm up against.
        aecWarmupDuration: null,
        userAwayTimeout: null,
      });

      this.#session = session;
      session.input.audio = this.#input;
      session.output.audio = this.#output;

      // No room: the whole voice loop runs against our own transport.
      await session.start({ agent: new ReceptionistAgent() });
      this.#sessionStartMs = Date.now() - t0;

      // The agent speaks first, immediately. A silent open burns the three-minute
      // clock, and the harness cuts a call with no audible audio from us.
      session.say(GREETING, { allowInterruptions: true });
    } catch (err) {
      this.#errors.push(`session start: ${String(err)}`);
      console.error(`[call ${this.#callId}] session start failed: ${String(err)}`);
      // The call is lost, but the submission is not: finish() still posts.
      void this.finish('session_start_failed');
    }
  }

  // --- ending -------------------------------------------------------------

  /** Idempotent. Reached from `stop`, from socket close, from the wall clock, or from a failure. */
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

    // Close the socket before deciding: the 30 s clock starts at close, and a
    // decision made against a still-open socket only shortens our own window.
    if (this.#ws.readyState === this.#ws.OPEN) {
      try {
        this.#ws.close();
      } catch {
        // Already going.
      }
    }
    this.#closedAt ??= Date.now();
    if (!Number.isFinite(this.#deadlineAt)) {
      this.#deadlineAt = this.#closedAt + config.submitWindowMs;
    }

    // Shut the session down alongside the decision rather than before it — its
    // teardown talks to Deepgram and we do not owe that any of the window.
    const closing = this.#session
      ?.close()
      .catch((err: unknown) => this.#errors.push(`session close: ${String(err)}`));

    const budget = this.#deadlineAt - Date.now() - config.submitReserveMs;
    const decided = await decide(
      {
        callId: this.#callId,
        transcript: this.#transcript,
        fromNumber: this.#fromNumber,
        now: new Date(),
      },
      budget,
    );

    const actions = this.#actionsFor(decided);
    const submitStartedAt = Date.now();
    let submissions: SubmitResult[] = [];
    if (this.#callId) {
      submissions = await submitActions(this.#callId, actions);
    } else {
      this.#errors.push('no call_id: never received a start message, nothing to submit against');
    }

    await closing;
    await this.#writeLog(decided, submissions, submitStartedAt);

    const verdict = submissions.map((s) => `${s.action}=${s.status}`).join(' ') || 'none';
    console.log(
      `[call ${this.#callId}] end (${this.#endedBy}) · turns=${this.#transcript.length} · ${verdict}`,
    );
  }

  /**
   * Past the deadline nothing can be accepted, so a late POST is a 410 however
   * right it is — but we submit anyway, because a 410 in the log is evidence and
   * a skipped POST is not.
   */
  #actionsFor(decided: DeciderResult): Action[] {
    if (decided.output.actions.length > 0) return decided.output.actions;
    this.#errors.push('decider returned no actions');
    return [FLOOR_ACTION];
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

