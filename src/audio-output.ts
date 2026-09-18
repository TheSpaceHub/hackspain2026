import type { AudioFrame } from '@livekit/rtc-node';
import { voice } from '@livekit/agents';
import { pcm16ToMulaw } from './mulaw.js';
import { FRAME_BYTES, FRAME_MS, SAMPLE_RATE, outboundClear, outboundMedia } from './twilio.js';

/** One utterance. LiveKit segments these with flush() and clearBuffer(). */
interface Segment {
  chunks: Uint8Array[];
  /** flush() has been called: no more audio is coming for this segment. */
  closed: boolean;
  /** Frames of this segment already on the wire, for the playback position report. */
  sent: number;
  started: boolean;
  createdAt: number;
}

/**
 * Agent audio, from the AgentSession out to the socket.
 *
 * Two things matter here and only here:
 *
 *  - **Pacing.** Frames go out one per 20 ms of wall clock, not flushed in a
 *    burst. An unpaced flush makes barge-in impossible, because by the time the
 *    caller interrupts, the audio they are interrupting has already left.
 *  - **Local barge-in.** The harness implements no server-side barge-in and says
 *    `clear` has no effect on its side today, so clearBuffer() has to drop our
 *    own queued frames and stop sending. We send `clear` too — it is free and may
 *    start working — but nothing depends on it.
 *
 * One instance per socket.
 */
export class MediaStreamAudioOutput extends voice.AudioOutput {
  #send: (data: string) => void;
  #streamSid: string;
  #segments: Segment[] = [];
  #timer: NodeJS.Timeout | null = null;
  #nextSendAt = 0;
  #closed = false;

  constructor(streamSid: string, send: (data: string) => void) {
    super(SAMPLE_RATE);
    this.#streamSid = streamSid;
    this.#send = send;
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    if (this.#closed) return;
    await super.captureFrame(frame);

    const pcm = toMono8k(frame);
    const mulaw = pcm16ToMulaw(pcm);

    let segment = this.#segments.at(-1);
    if (!segment || segment.closed) {
      segment = { chunks: [], closed: false, sent: 0, started: false, createdAt: Date.now() };
      this.#segments.push(segment);
    }
    // Aura-2 hands us whole utterances; the wire wants exactly 160 bytes per message.
    for (let off = 0; off < mulaw.length; off += FRAME_BYTES) {
      segment.chunks.push(mulaw.subarray(off, Math.min(off + FRAME_BYTES, mulaw.length)));
    }
    this.#startPump();
  }

  /** End of utterance. The segment finishes when the last queued frame is actually sent. */
  override flush(): void {
    super.flush();
    const segment = this.#segments.at(-1);
    if (segment) segment.closed = true;
    this.#drainFinished();
  }

  /** Interruption. Drop everything we have not sent and report what did play. */
  override clearBuffer(): void {
    const dropped = this.#segments;
    this.#segments = [];
    this.abandonOpenSegment();
    this.#stopPump();

    if (!this.#closed) this.#send(outboundClear(this.#streamSid));

    // Every captured-but-unfinished segment has to be reported, or the session
    // waits forever on a playout that will never arrive.
    let pending = this.pendingPlayoutSegments;
    let i = 0;
    while (pending > 0) {
      const sent = dropped[i]?.sent ?? 0;
      this.onPlaybackFinished({ playbackPosition: (sent * FRAME_MS) / 1000, interrupted: true });
      pending--;
      i++;
    }
  }

  /** Socket is gone. Stop sending and release any segment the session is waiting on. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#segments = [];
    this.#stopPump();
    this.abandonOpenSegment();
    let pending = this.pendingPlayoutSegments;
    while (pending-- > 0) {
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
  }

  // --- paced sender -------------------------------------------------------

  #startPump(): void {
    if (this.#timer || this.#closed) return;
    this.#nextSendAt = Date.now();
    this.#tick();
  }

  #stopPump(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #tick = (): void => {
    this.#timer = null;
    if (this.#closed) return;

    const now = Date.now();
    // Drift-corrected: catch up if the event loop held us up, rather than
    // letting a few milliseconds per frame accumulate into audible lag.
    if (this.#nextSendAt < now - FRAME_MS * 10) this.#nextSendAt = now;

    let budget = 10;
    while (this.#nextSendAt <= now && budget-- > 0) {
      if (!this.#sendOne()) break;
      this.#nextSendAt += FRAME_MS;
    }

    this.#drainFinished();
    if (this.#segments.length === 0) return;
    this.#timer = setTimeout(this.#tick, Math.max(0, this.#nextSendAt - Date.now()));
  };

  /** Send a single 20 ms frame. Returns false when there is nothing to send. */
  #sendOne(): boolean {
    const segment = this.#segments[0];
    if (!segment) return false;
    const chunk = segment.chunks[segment.sent];
    if (!chunk) return false;

    if (!segment.started) {
      segment.started = true;
      this.onPlaybackStarted(segment.createdAt);
    }
    this.#send(outboundMedia(this.#streamSid, Buffer.from(chunk).toString('base64')));
    segment.sent++;
    return true;
  }

  /** Retire segments that are closed and fully on the wire. */
  #drainFinished(): void {
    while (this.#segments.length > 0) {
      const segment = this.#segments[0]!;
      if (!segment.closed || segment.sent < segment.chunks.length) return;
      this.#segments.shift();
      this.onPlaybackFinished({
        playbackPosition: (segment.sent * FRAME_MS) / 1000,
        interrupted: false,
      });
    }
  }
}

/**
 * Deepgram is configured at mulaw/8000 so frames should already arrive mono at
 * 8 kHz. This is the insurance policy for when they do not: average the channels
 * and linearly resample. It is a no-op on the expected path.
 */
function toMono8k(frame: AudioFrame): Int16Array {
  const { data, channels, sampleRate, samplesPerChannel } = frame;

  let mono: Int16Array;
  if (channels === 1) {
    mono = data;
  } else {
    mono = new Int16Array(samplesPerChannel);
    for (let i = 0; i < samplesPerChannel; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += data[i * channels + c] ?? 0;
      mono[i] = (sum / channels) | 0;
    }
  }

  if (sampleRate === SAMPLE_RATE) return mono;

  const ratio = sampleRate / SAMPLE_RATE;
  const out = new Int16Array(Math.floor(mono.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, mono.length - 1);
    const frac = src - lo;
    out[i] = ((mono[lo] ?? 0) * (1 - frac) + (mono[hi] ?? 0) * frac) | 0;
  }
  return out;
}
