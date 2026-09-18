/**
 * Paced sender and local barge-in, no network. Neither shows up in a call log: an unpaced
 * flush sounds fine until someone interrupts, and an unreported segment hangs the session.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { initializeLogger } from '@livekit/agents';
import { MediaStreamAudioOutput } from '../src/audio-output.js';

initializeLogger({ pretty: false, level: 'error' });

const sent: string[] = [];
const out = new MediaStreamAudioOutput('MZtest', (d) => sent.push(d));

// One second, handed over in a burst the way a TTS stream does.
const oneSecond = new Int16Array(8000);
for (let i = 0; i < 8000; i++) oneSecond[i] = Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / 8000));

const finished: { interrupted: boolean; playbackPosition: number }[] = [];
out.on('playbackFinished', (e) => finished.push(e));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (evt: string) => sent.filter((s) => JSON.parse(s).event === evt).length;

async function main(): Promise<void> {
  // --- pacing --------------------------------------------------------------
  const t0 = Date.now();
  await out.captureFrame(new AudioFrame(oneSecond, 8000, 1, 8000));
  out.flush();

  await sleep(100);
  const at100 = count('media');
  await sleep(400);
  const at500 = count('media');

  console.log(`after 100ms: ${at100} frames (paced would be ~5, unpaced 50)`);
  console.log(`after 500ms: ${at500} frames (paced would be ~25)`);
  console.log(`PACED: ${at100 <= 10 && at500 >= 18 && at500 <= 32 ? 'PASS' : 'FAIL'}`);

  // --- barge-in ------------------------------------------------------------
  out.clearBuffer();
  const atCut = count('media');
  await sleep(300);
  const after = count('media');
  console.log(`\nfrozen at ${atCut} frames, ${after - atCut} arrived in the 300ms after clearBuffer()`);
  console.log(`BARGE-IN drops queued audio: ${after === atCut ? 'PASS' : 'FAIL'}`);
  console.log(`BARGE-IN sends clear anyway: ${count('clear') === 1 ? 'PASS' : 'FAIL'}`);
  console.log(`BARGE-IN reports interrupted playout: ${finished.length === 1 && finished[0]!.interrupted ? 'PASS' : 'FAIL'} (${JSON.stringify(finished)})`);
  console.log(`no playout left pending: ${out.pendingPlayoutSegments === 0 ? 'PASS' : 'FAIL'}`);

  // --- a second utterance still works after an interruption ----------------
  const short = new Int16Array(1600); // 200 ms
  await out.captureFrame(new AudioFrame(short, 8000, 1, 1600));
  out.flush();
  await sleep(400);
  console.log(`\nsecond utterance after barge-in: ${count('media') - atCut} frames (expect 10)`);
  console.log(`segment completed uninterrupted: ${finished.length === 2 && !finished[1]!.interrupted ? 'PASS' : 'FAIL'}`);

  // --- resampling insurance -------------------------------------------------
  const at16k = new Int16Array(1600); // 100 ms at 16 kHz
  const before = count('media');
  await out.captureFrame(new AudioFrame(at16k, 16000, 1, 1600));
  out.flush();
  await sleep(250);
  console.log(`\n16 kHz frame -> ${count('media') - before} frames of 8 kHz output (expect 5)`);

  const sizes = new Set(sent.filter((s) => JSON.parse(s).event === 'media')
    .map((s) => Buffer.from(JSON.parse(s).media.payload, 'base64').length));
  console.log(`payload sizes on the wire: ${[...sizes].join(', ')} bytes (must be 160)`);
  out.close();
}
main();
