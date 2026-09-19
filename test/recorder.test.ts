import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallRecorder } from '../src/recorder.js';
import { readWav } from './wav.js';

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
}

const dir = await mkdtemp(join(tmpdir(), 'el-turno-recorder-'));
const path = join(dir, 'call.wav');
const recorder = new CallRecorder({ path, startedAt: 0, flushEveryMs: 5, lagMs: 0 });
const chunks: Buffer[] = [];
recorder.on('chunk', (chunk) => chunks.push(chunk));
const frame = new Uint8Array(160).fill(0);
for (const at of [0, 20, 40, 60, 80]) recorder.caller(frame, at);
for (const at of [40, 60, 80]) recorder.agent(frame, at);

await new Promise((resolve) => setTimeout(resolve, 20));
const flushedBeforeLate = recorder.flushedBytes;
recorder.caller(frame, 0);
check('late frame does not change flushed bytes', recorder.flushedBytes, flushedBeforeLate);

const summary = await recorder.close();
const wav = await readWav(path);
const file = await readFile(path);
const data = file.subarray(44);
const emitted = Buffer.concat(chunks);
const frames = wav.samples.length / wav.channels;
const channel = (index: number): Int16Array => {
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = wav.samples[i * 2 + index]!;
  return samples;
};
const caller = channel(0);
const agent = channel(1);
check('channels', wav.channels, 2);
check('sample rate', wav.sampleRate, 8000);
check('total frames', frames, 800);
check('caller channel is non-zero', caller.some((sample) => sample !== 0), true);
check('agent channel is silent before its first frame', agent.slice(0, 320).every((sample) => sample === 0), true);
check('agent channel is non-zero after its first frame', agent.slice(320).some((sample) => sample !== 0), true);
check('chunks equal WAV data', emitted.equals(data), true);
check('summary bytes', summary.bytes, data.length);

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
if (failures > 0) process.exit(1);
