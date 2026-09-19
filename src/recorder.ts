import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mulawToPcm16 } from './mulaw.js';

export interface RecordingSummary {
  path: string;
  duration_ms: number;
  bytes: number;
}

export function wavHeader(opts: { channels: number; sampleRate: number; dataBytes: number }): Buffer {
  const blockAlign = opts.channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE((36 + opts.dataBytes) >>> 0, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(opts.channels, 22);
  header.writeUInt32LE(opts.sampleRate, 24);
  header.writeUInt32LE(opts.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(opts.dataBytes >>> 0, 40);
  return header;
}

export class CallRecorder extends EventEmitter {
  readonly #path: string;
  readonly #startedAt: number;
  readonly #flushEveryMs: number;
  readonly #lagMs: number;
  readonly #stream: ReturnType<typeof createWriteStream> | null;
  #pending = [new Int16Array(160), new Int16Array(160)];
  #timer: NodeJS.Timeout | null = null;
  #nextFlushSample = 0;
  #latestSample = 0;
  #flushed = 0;
  #lateFrames = 0;
  #closing: Promise<RecordingSummary> | null = null;

  constructor(opts: { path: string; startedAt?: number; flushEveryMs?: number; lagMs?: number }) {
    super();
    this.setMaxListeners(0);
    this.#path = opts.path;
    this.#startedAt = opts.startedAt ?? Date.now();
    this.#flushEveryMs = opts.flushEveryMs ?? 100;
    this.#lagMs = opts.lagMs ?? 200;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      this.#stream = createWriteStream(this.#path);
      this.#stream.on('error', (err) => console.error(`[recorder] ${this.#path}: ${String(err)}`));
      this.#stream.write(wavHeader({ channels: 2, sampleRate: 8000, dataBytes: 0 }));
      this.#timer = setInterval(this.#flushTimer, this.#flushEveryMs);
      this.#timer.unref();
    } catch (err) {
      console.error(`[recorder] failed to open ${this.#path}: ${String(err)}`);
      this.#stream = null;
    }
  }

  get flushedBytes(): number {
    return this.#flushed;
  }

  caller(mulaw: Uint8Array, at = Date.now()): void {
    this.#add(0, mulaw, at);
  }

  agent(mulaw: Uint8Array, at = Date.now()): void {
    this.#add(1, mulaw, at);
  }

  async close(): Promise<RecordingSummary> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#finish();
    return this.#closing;
  }

  #add(channel: 0 | 1, mulaw: Uint8Array, at: number): void {
    try {
      if (!this.#stream || mulaw.length === 0) return;
      const start = Math.round((at - this.#startedAt) * 8);
      const pcm = mulawToPcm16(mulaw);
      this.#ensureCapacity(start + pcm.length);
      const pending = this.#pending[channel]!;
      let late = false;
      for (let i = 0; i < pcm.length; i++) {
        const position = start + i;
        if (position < this.#nextFlushSample || position < 0) {
          late = true;
          continue;
        }
        pending[position - this.#nextFlushSample] = pcm[i]!;
        this.#latestSample = Math.max(this.#latestSample, position + 1);
      }
      if (late) this.#lateFrames++;
    } catch (err) {
      console.error(`[recorder] failed to record frame: ${String(err)}`);
    }
  }

  #flushTimer = (): void => {
    try {
      this.#flushEligible();
    } catch (err) {
      console.error(`[recorder] flush failed: ${String(err)}`);
    }
  };

  #flushEligible(): void {
    const watermark = Math.min(
      this.#latestSample,
      Math.max(0, Math.round((Date.now() - this.#startedAt - this.#lagMs) * 8)),
    );
    this.#flushTo(watermark);
  }

  #flushTo(end: number): void {
    if (!this.#stream || end <= this.#nextFlushSample) return;
    const stream = this.#stream;
    const frames = end - this.#nextFlushSample;
    this.#ensureCapacity(end);
    const chunk = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      chunk.writeInt16LE(this.#pending[0]![i]!, i * 4);
      chunk.writeInt16LE(this.#pending[1]![i]!, i * 4 + 2);
    }
    for (const pending of this.#pending) {
      pending.copyWithin(0, frames);
      pending.fill(0, pending.length - frames);
    }
    this.#nextFlushSample = end;
    this.#flushed += chunk.length;
    stream.write(chunk);
    this.emit('chunk', chunk);
  }

  #ensureCapacity(end: number): void {
    const required = end - this.#nextFlushSample;
    if (required <= this.#pending[0]!.length) return;
    let capacity = this.#pending[0]!.length;
    while (capacity < required) capacity *= 2;
    const left = new Int16Array(capacity);
    const right = new Int16Array(capacity);
    left.set(this.#pending[0]!);
    right.set(this.#pending[1]!);
    this.#pending = [left, right];
  }

  async #finish(): Promise<RecordingSummary> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#flushTo(this.#latestSample);
    const bytes = this.#flushed;
    if (this.#lateFrames > 0) {
      console.warn(`[recorder] dropped ${this.#lateFrames} late frames for ${this.#path}`);
    }

    if (this.#stream) {
      const stream = this.#stream;
      await new Promise<void>((resolve) => stream.end(resolve));
      try {
        const handle = await open(this.#path, 'r+');
        await handle.write(wavHeader({ channels: 2, sampleRate: 8000, dataBytes: bytes }), 0, 44, 0);
        await handle.close();
      } catch (err) {
        console.error(`[recorder] failed to patch ${this.#path}: ${String(err)}`);
      }
    }
    const summary = {
      path: this.#path,
      duration_ms: bytes / (2 * 2 * 8000) * 1000,
      bytes,
    };
    this.emit('close', summary);
    return summary;
  }
}
