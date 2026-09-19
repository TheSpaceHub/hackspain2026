/**
 * G.711 µ-law, the phone line's 8-bit encoding. The same tables as the agent's
 * src/mulaw.ts — the console may only import the agent's types, not its code.
 */

const BIAS = 0x84;
const CLIP = 32635;

const DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exponent = (u >> 4) & 0x07;
  const sample = (((u & 0x0f) << 3) + BIAS) * 2 ** exponent - BIAS;
  DECODE[i] = (u & 0x80 ? -sample : sample) / 32768;
}

function encodeSample(pcm: number): number {
  let sample = pcm;
  const sign = sample < 0 ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Float samples in [-1, 1] → base64 µ-law, as a Media Streams `payload`. */
export function encodePayload(samples: Float32Array): string {
  let binary = '';
  for (const s of samples) {
    const pcm = Math.round(Math.max(-1, Math.min(1, s)) * 32767);
    binary += String.fromCharCode(encodeSample(pcm));
  }
  return btoa(binary);
}

/** A Media Streams `payload` → float samples in [-1, 1]. */
export function decodePayload(payload: string): Float32Array {
  const binary = atob(payload);
  const out = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = DECODE[binary.charCodeAt(i)]!;
  return out;
}
