import { readFile, writeFile } from 'node:fs/promises';

/** Minimal RIFF/WAVE, PCM16 only. */

export interface Wav {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}

export async function readWav(path: string): Promise<Wav> {
  const buf = await readFile(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let sampleRate = 8000;
  let channels = 1;
  let bits = 16;
  let data: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }

  if (!data) throw new Error(`${path}: no data chunk`);
  if (bits !== 16) throw new Error(`${path}: ${bits}-bit audio, expected 16-bit PCM`);

  const interleaved = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  return { samples: Int16Array.from(interleaved), sampleRate, channels };
}

export async function writeWav(path: string, samples: Int16Array, sampleRate: number): Promise<void> {
  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(bytes, 40);
  await writeFile(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, bytes)]));
}

/** Fold to mono and resample; linear is fine for 8 kHz speech. */
export function toMono(wav: Wav, targetRate: number): Int16Array {
  let mono: Int16Array;
  if (wav.channels === 1) {
    mono = wav.samples;
  } else {
    const frames = Math.floor(wav.samples.length / wav.channels);
    mono = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < wav.channels; c++) sum += wav.samples[i * wav.channels + c] ?? 0;
      mono[i] = (sum / wav.channels) | 0;
    }
  }

  if (wav.sampleRate === targetRate) return mono;
  const ratio = wav.sampleRate / targetRate;
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
