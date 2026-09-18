import type { AudioFrame } from '@livekit/rtc-node';
import { voice } from '@livekit/agents';
import { pcm16ToMulaw } from './mulaw.js';
import { FRAME_BYTES, FRAME_MS, SAMPLE_RATE, outboundClear, outboundMedia } from './twilio.js';

/** One utterance; LiveKit segments these with flush() and clearBuffer(). */
interface Segment {
  chunks: Uint8Array[];
  closed: boolean;
  /** Frames already on the wire, for the playback position report. */
  sent: number;
  started: boolean;
  createdAt: number;
}

/**
 * Agent audio out. One per socket.
 *
 * Paced at one frame per 20 ms: an unpaced flush makes barge-in impossible, since the
 * audio being interrupted has already left. The harness does no server-side barge-in and
 * `clear` is a no-op there, so clearBuffer() drops our own queue.
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
    // The wire wants exactly 160 bytes per message.
    for (let off = 0; off < mulaw.length; off += FRAME_BYTES) {
      segment.chunks.push(mulaw.subarray(off, Math.min(off + FRAME_BYTES, mulaw.length)));
    }
    this.#startPump();
  }

  /** The segment finishes when its last queued frame is actually sent. */
  override flush(): void {
    super.flush();
    const segment = this.#segments.at(-1);
    if (segment) segment.closed = true;
    this.#drainFinished();
  }

  /** Drop what we have not sent; report what did play. */
  override clearBuffer(): void {
    const dropped = this.#segments;
    this.#segments = [];
    this.abandonOpenSegment();
    this.#stopPump();

    if (!this.#closed) this.#send(outboundClear(this.#streamSid));

    // Unreported segments hang the session on a playout that never arrives.
    let pending = this.pendingPlayoutSegments;
    let i = 0;
    while (pending > 0) {
      const sent = dropped[i]?.sent ?? 0;
      this.onPlaybackFinished({ playbackPosition: (sent * FRAME_MS) / 1000, interrupted: true });
      pending--;
      i++;
    }
  }

  /** Socket gone: stop sending, release any segment the session awaits. */
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
    // Drift-corrected, or a few ms per frame accumulates into audible lag.
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

  /** Returns false when there is nothing to send. */
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

  /** Retire segments closed and fully on the wire. */
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

/** No-op on the expected path (mono 8 kHz); insurance for anything else. */
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
