import { CAPTURE_WORKLET } from './capture-worklet';
import { decodePayload, encodePayload } from './mulaw';

/**
 * A phone call to the agent from the browser. It speaks what Prosper speaks — Twilio
 * Media Streams over a WebSocket: `start` with a call id, 20 ms µ-law `media` frames
 * both ways, `stop` on hang-up — so the agent cannot tell it from the real caller.
 */

export type CallPhase = 'idle' | 'connecting' | 'live' | 'ended';

export interface CallSnapshot {
  phase: CallPhase;
  callId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Microphone level, 0–1, smoothed. */
  micLevel: number;
  agentSpeaking: boolean;
  /** Why the call could not start or ended early; null on a clean hang-up. */
  error: string | null;
}

export interface CallOptions {
  endpoint: string;
  /** The number the agent sees the call from; empty for a withheld caller. */
  fromNumber: string;
}

const LINE_RATE = 8000;

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class TestCall {
  #snapshot: CallSnapshot = { phase: 'idle', callId: null, startedAt: null, endedAt: null, micLevel: 0, agentSpeaking: false, error: null };
  #listeners = new Set<(s: CallSnapshot) => void>();

  #ws: WebSocket | null = null;
  #ctx: AudioContext | null = null;
  #mic: MediaStream | null = null;
  #worklet: AudioWorkletNode | null = null;
  #streamSid = '';
  #sequence = 1;
  #chunk = 1;
  /** When the agent's queued audio runs out, on the AudioContext clock. */
  #playUntil = 0;
  #playing = new Set<AudioBufferSourceNode>();
  #ticker: number | null = null;

  get snapshot(): CallSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (s: CallSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Read fresh after every await: a hang-up can land while one is pending. */
  #stillConnecting(): boolean {
    return this.#snapshot.phase === 'connecting';
  }

  #set(patch: Partial<CallSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const l of this.#listeners) l(this.#snapshot);
  }

  async start({ endpoint, fromNumber }: CallOptions): Promise<void> {
    if (this.#snapshot.phase === 'connecting' || this.#snapshot.phase === 'live') return;
    const callId = `test-${crypto.randomUUID()}`;
    this.#streamSid = `MZ${randomHex(16)}`;
    this.#sequence = 1;
    this.#chunk = 1;
    this.#set({ phase: 'connecting', callId, startedAt: null, endedAt: null, micLevel: 0, agentSpeaking: false, error: null });

    try {
      // Echo cancellation matters: without it the agent hears itself through the speakers.
      this.#mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (err) {
      this.#fail(`Microphone blocked: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Hung up while the browser was still asking for the microphone.
    if (!this.#stillConnecting()) {
      for (const track of this.#mic.getTracks()) track.stop();
      this.#mic = null;
      return;
    }

    const ctx = new AudioContext();
    this.#ctx = ctx;
    const moduleUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
    try {
      // The permission prompt can outlast the click that started the call; resume explicitly.
      await ctx.resume();
      await ctx.audioWorklet.addModule(moduleUrl);
    } catch (err) {
      if (this.#stillConnecting()) this.#fail(`Audio unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    // Hung up while the audio was being set up.
    if (!this.#stillConnecting()) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint);
    } catch (err) {
      this.#fail(`Bad endpoint: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.#ws = ws;

    ws.onopen = () => {
      this.#send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
      this.#send({
        event: 'start',
        sequenceNumber: String(this.#sequence++),
        streamSid: this.#streamSid,
        start: {
          streamSid: this.#streamSid,
          callSid: callId,
          tracks: ['inbound'],
          customParameters: { call_id: callId, ...(fromNumber.trim() ? { from_number: fromNumber.trim() } : {}) },
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: LINE_RATE, channels: 1 },
        },
      });
      this.#startMic();
      this.#set({ phase: 'live', startedAt: Date.now() });
    };
    ws.onmessage = (e) => this.#onMessage(e.data);
    ws.onerror = () => {
      if (this.#stillConnecting()) this.#fail(`Could not reach ${endpoint}`);
    };
    // The agent hangs up too: at the end of the conversation, or at the three-minute cut.
    ws.onclose = () => {
      if (this.#snapshot.phase === 'live') this.#teardown(null);
    };
  }

  hangUp(): void {
    if (this.#snapshot.phase !== 'live' && this.#snapshot.phase !== 'connecting') return;
    this.#send({ event: 'stop', sequenceNumber: String(this.#sequence++), streamSid: this.#streamSid });
    this.#teardown(null);
  }

  #startMic(): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#mic) return;
    const source = ctx.createMediaStreamSource(this.#mic);
    const node = new AudioWorkletNode(ctx, 'capture-8k');
    // Silent sink: keeps the worklet pulled by the graph without playing the mic back.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(ctx.destination);
    this.#worklet = node;

    let level = 0;
    node.port.onmessage = (e: MessageEvent<{ frame: Float32Array; level: number }>) => {
      const timestamp = String((this.#chunk - 1) * 20);
      this.#send({
        event: 'media',
        sequenceNumber: String(this.#sequence++),
        streamSid: this.#streamSid,
        media: { track: 'inbound', chunk: String(this.#chunk++), timestamp, payload: encodePayload(e.data.frame) },
      });
      level = Math.max(e.data.level * 4, level * 0.85);
      this.#set({ micLevel: Math.min(1, level) });
    };

    // Whether the agent is talking is just whether its audio is still queued.
    this.#ticker = window.setInterval(() => {
      const speaking = !!this.#ctx && this.#ctx.currentTime < this.#playUntil;
      if (speaking !== this.#snapshot.agentSpeaking) this.#set({ agentSpeaking: speaking });
    }, 100);
  }

  #onMessage(data: unknown): void {
    let msg: { event?: string; media?: { payload?: string } };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.event === 'media' && msg.media?.payload) this.#play(decodePayload(msg.media.payload));
    // The agent was interrupted: drop what it had queued, as a phone line would.
    else if (msg.event === 'clear') this.#stopPlayback();
  }

  #play(samples: Float32Array): void {
    const ctx = this.#ctx;
    if (!ctx || samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, LINE_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    // Frames arrive paced in real time; queue each right after the last so none overlap.
    const at = Math.max(ctx.currentTime + 0.05, this.#playUntil);
    node.start(at);
    this.#playUntil = at + buffer.duration;
    this.#playing.add(node);
    node.onended = () => this.#playing.delete(node);
  }

  #stopPlayback(): void {
    for (const node of this.#playing) {
      try {
        node.stop();
      } catch {
        // already finished
      }
    }
    this.#playing.clear();
    this.#playUntil = 0;
  }

  #send(msg: object): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  #fail(error: string): void {
    this.#teardown(error);
  }

  #teardown(error: string | null): void {
    if (this.#ticker !== null) window.clearInterval(this.#ticker);
    this.#ticker = null;
    this.#stopPlayback();
    this.#worklet?.port.close();
    this.#worklet?.disconnect();
    this.#worklet = null;
    for (const track of this.#mic?.getTracks() ?? []) track.stop();
    this.#mic = null;
    void this.#ctx?.close();
    this.#ctx = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    this.#set({ phase: 'ended', endedAt: Date.now(), micLevel: 0, agentSpeaking: false, error });
  }
}
