/**
 * G.711 µ-law <-> PCM16. The only place in the build that touches raw sample bytes.
 * Table-driven both ways: a call is 50 frames a second across twenty sockets.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** µ-law byte -> PCM16 sample. 256 entries, built once. */
const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  DECODE[i] = sign ? -sample : sample;
}

/** PCM16 sample (offset by 32768) -> µ-law byte. 65536 entries, ~64 KB, built once. */
const ENCODE = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
  let sample = i - 32768;
  const sign = sample < 0 ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  ENCODE[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToPcm16(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) out[i] = DECODE[mulaw[i]!]!;
  return out;
}

export function pcm16ToMulaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = ENCODE[(pcm[i]! + 32768) & 0xffff]!;
  return out;
}
