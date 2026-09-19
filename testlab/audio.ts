/**
 * The caller's voice, and the room they are calling from.
 *
 * espeak-ng offline (or `say` on macOS) for the words, and a procedural bed for
 * the noise cases — a street, a television, a room, a car — mixed in at a given
 * signal-to-noise ratio so problem 12 is a real 5 dB call and not a label.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readWav, toMono } from '../test/wav.js';
import type { AudioBed, Background } from '../mock/world/suite/types.js';

const exec = promisify(execFile);

export const SAMPLE_RATE = 8000;

/** espeak-ng speaks es and ca as well, which is what problem 11 needs. */
const VOICES: Record<string, { male: string; female: string }> = {
  en: { male: 'en-us', female: 'en-us+f3' },
  es: { male: 'es', female: 'es+f3' },
  ca: { male: 'ca', female: 'ca+f3' },
};

let warnedSilence = false;

export interface Voice {
  language: string;
  sex: 'male' | 'female';
  /** Words per minute; 150 is ordinary speech. */
  wpm?: number;
  /** Linear gain, under 1 for a caller who is hard to hear. */
  gain?: number;
}

/** One line of speech at 8 kHz. Falls back to plausible silence when nothing can speak. */
export async function say(line: string, voice: Voice): Promise<Int16Array> {
  const dir = await mkdtemp(join(tmpdir(), 'testlab-tts-'));
  const wav = join(dir, 'line.wav');
  try {
    if (process.platform === 'darwin') {
      await exec('say', ['-r', String(voice.wpm ?? 150), '-o', wav, '--file-format=WAVE', '--data-format=LEI16@8000', line]);
      return amplify(toMono(await readWav(wav), SAMPLE_RATE), voice.gain ?? 1);
    }
    const v = VOICES[voice.language] ?? VOICES.en!;
    const args = ['-v', voice.sex === 'female' ? v.female : v.male, '-s', String(voice.wpm ?? 150), '-w', wav, line];
    await exec('espeak-ng', args);
    return amplify(toMono(await readWav(wav), SAMPLE_RATE), voice.gain ?? 1);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (!warnedSilence) {
      warnedSilence = true;
      console.warn('[testlab] espeak-ng not found — callers will be silent (apt install espeak-ng)');
    }
    return new Int16Array(Math.round(SAMPLE_RATE * (1.5 + line.length / 15)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function amplify(pcm: Int16Array, gain: number): Int16Array {
  if (gain === 1) return pcm;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i]! * gain)));
  return out;
}

/** Silence of a given length, so a pause is on the wire rather than a gap in it. */
export function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
}

/** Deterministic noise, so a case that failed under a bed fails under the same one again. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

/**
 * Each bed is white noise through a one-pole filter plus whatever gives it away:
 * traffic swells on a street, speech-band babble from a television, a hum in a car.
 */
function bed(kind: Background, samples: number, seed: number): Float32Array {
  const out = new Float32Array(samples);
  if (kind === 'silence') return out;
  const rand = rng(seed);
  let low = 0;
  let band = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const white = rand();
    low = low * 0.95 + white * 0.05;
    band = band * 0.6 + (white - low) * 0.4;
    if (kind === 'street') {
      // Rumble, with a vehicle passing every few seconds.
      const pass = Math.exp(-(((t % 4.5) - 2) ** 2) / 0.35);
      out[i] = low * 6 + band * 0.4 + pass * white * 0.8;
    } else if (kind === 'television') {
      // Babble: speech-band noise with sentence-length envelopes.
      const envelope = 0.4 + 0.6 * Math.abs(Math.sin(2 * Math.PI * 0.35 * t));
      out[i] = band * envelope * 1.6 + low * 1.5;
    } else if (kind === 'room') {
      out[i] = low * 3 + band * 0.6;
    } else {
      // A car: engine hum, road noise, and the indicator.
      const hum = Math.sin(2 * Math.PI * 92 * t) * 0.35 + Math.sin(2 * Math.PI * 47 * t) * 0.25;
      const tick = t % 1.4 < 0.03 ? 0.5 * white : 0;
      out[i] = hum + low * 4 + band * 0.3 + tick;
    }
  }
  return out;
}

function rms(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += Number(values[i]) ** 2;
  return Math.sqrt(sum / Math.max(1, values.length));
}

/**
 * Mixes the bed under the speech at the case's SNR, measured over the speech itself
 * so the ratio means what it says whatever the voice came out at.
 */
export function mix(speech: Int16Array, audio: AudioBed, seed: number): Int16Array {
  if (audio.background === 'silence' || audio.signal_to_noise_db === null) return speech;
  const noise = bed(audio.background, speech.length, seed);
  const speechRms = rms(speech);
  const noiseRms = rms(noise) || 1;
  const wanted = speechRms / 10 ** (audio.signal_to_noise_db / 20);
  const gain = wanted / noiseRms;
  const out = new Int16Array(speech.length);
  for (let i = 0; i < speech.length; i++) {
    const v = speech[i]! + noise[i]! * gain;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}
