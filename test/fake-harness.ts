/**
 * A local stand-in for the Prosper harness.
 *
 * It dials your own /ws speaking the same Twilio Media Streams messages the real
 * harness speaks, plays a scripted caller at 20 ms per frame, records whatever
 * the agent says back, and reports the timings. Nothing here runs in production —
 * it exists so turn-taking, barge-in and concurrency can be debugged without
 * spending a practice call, which is rate-limited to one per thirty seconds.
 *
 *   pnpm harness                              scripted booking call, one socket
 *   pnpm harness -- --n 10                    ten concurrent calls, the Run All shape
 *   pnpm harness -- --n 20                    the Switchboard burst
 *   pnpm harness -- --barge-in                talk over the agent's greeting
 *   pnpm harness -- --wav caller.wav          play a real recording instead
 *   pnpm harness -- --say "hello" --say "..."  synthesise lines with macOS `say`
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { mulawToPcm16, pcm16ToMulaw } from '../src/mulaw.js';
import { readWav, toMono, writeWav } from './wav.js';

const exec = promisify(execFile);

const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160;
const FRAME_MS = 20;

const DEFAULT_SCRIPT = [
  "Hello, yes, I'd like to book an appointment please.",
  "My name is Marta Ruiz. My D N I is one two three four five six seven eight Z.",
  "I need to see a doctor about a sore throat. I've had it since the weekend.",
  "Any time on Thursday morning would be great.",
  "Yes, that's right. Thank you very much. Goodbye.",
];

interface Options {
  url: string;
  count: number;
  script: string[];
  wav?: string;
  bargeIn: boolean;
  gapMs: number;
  outDir: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    url: process.env.HARNESS_URL ?? 'ws://127.0.0.1:7860/ws',
    count: 1,
    script: [],
    bargeIn: false,
    gapMs: 900,
    outDir: './calls',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--url' && next) opts.url = argv[++i]!;
    else if (arg === '--n' && next) opts.count = Number(argv[++i]);
    else if (arg === '--say' && next) opts.script.push(argv[++i]!);
    else if (arg === '--wav' && next) opts.wav = argv[++i]!;
    else if (arg === '--gap' && next) opts.gapMs = Number(argv[++i]);
    else if (arg === '--out' && next) opts.outDir = argv[++i]!;
    else if (arg === '--barge-in') opts.bargeIn = true;
  }
  if (opts.script.length === 0) opts.script = DEFAULT_SCRIPT;
  return opts;
}

/**
 * Turn a line into 8 kHz mono PCM using macOS `say` and `afconvert`, both of
 * which ship with the OS. On anything else, fall back to silence of a plausible
 * length so the pacing and concurrency paths can still be exercised.
 */
async function synthesise(line: string, dir: string, index: number): Promise<Int16Array> {
  if (process.platform !== 'darwin') {
    return new Int16Array(Math.round((SAMPLE_RATE * (1.5 + line.length / 15)) | 0));
  }
  const wav = join(dir, `line-${index}.wav`);
  // CoreAudio downsamples properly on the way out, so this is already the
  // 8 kHz band-limited audio a real phone line would deliver.
  await exec('say', ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@8000', line]);
  return toMono(await readWav(wav), SAMPLE_RATE);
}

async function buildTurns(opts: Options, dir: string): Promise<Int16Array[]> {
  if (opts.wav) return [toMono(await readWav(opts.wav), SAMPLE_RATE)];
  const turns: Int16Array[] = [];
  for (const [i, line] of opts.script.entries()) {
    turns.push(await synthesise(line, dir, i));
  }
  return turns;
}

interface CallReport {
  callId: string;
  ok: boolean;
  framesSent: number;
  framesReceived: number;
  msToFirstAudio?: number;
  clears: number;
  error?: string;
  outPath?: string;
}

async function runCall(opts: Options, turns: Int16Array[], index: number): Promise<CallReport> {
  const callId = randomUUID();
  const streamSid = `MZ${randomUUID().replace(/-/g, '')}`.slice(0, 34);
  const fromNumber = `+3461234${String(5000 + index).slice(-4)}`;
  const report: CallReport = { callId, ok: false, framesSent: 0, framesReceived: 0, clears: 0 };

  const received: number[] = [];
  let lastInboundAt = 0;
  let openedAt = 0;

  const ws = new WebSocket(opts.url);

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  openedAt = Date.now();

  ws.on('message', (data) => {
    let msg: { event?: string; media?: { payload?: string } };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.event === 'media' && msg.media?.payload) {
      report.framesReceived++;
      report.msToFirstAudio ??= Date.now() - openedAt;
      lastInboundAt = Date.now();
      const pcm = mulawToPcm16(Buffer.from(msg.media.payload, 'base64'));
      for (const s of pcm) received.push(s);
    } else if (msg.event === 'clear') {
      report.clears++;
    }
  });

  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

  const send = (obj: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  let seq = 1;
  send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
  send({
    event: 'start',
    sequenceNumber: String(seq++),
    streamSid,
    start: {
      streamSid,
      accountSid: 'ACfake',
      callSid: callId,
      tracks: ['inbound'],
      customParameters: { call_id: callId, from_number: fromNumber },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: SAMPLE_RATE, channels: 1 },
    },
  });

  // A phone line is always sending. Between turns the caller is silent, but the
  // frames keep coming, and STT endpointing depends on hearing that silence —
  // a harness that simply stops sending never lets an utterance close.
  const SILENCE = new Int16Array(FRAME_SAMPLES);
  let pending: Int16Array[] = [];

  const pumpFrame = (): void => {
    const frame = pending.shift() ?? SILENCE;
    send({
      event: 'media',
      sequenceNumber: String(seq++),
      streamSid,
      media: {
        track: 'inbound',
        chunk: String(seq),
        timestamp: String(report.framesSent * FRAME_MS),
        payload: Buffer.from(pcm16ToMulaw(frame)).toString('base64'),
      },
    });
    report.framesSent++;
  };

  /** Start the line and return the way to stop it. */
  const startPump = (): (() => void) => {
    let nextAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const tick = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      pumpFrame();
      nextAt += FRAME_MS;
      timer = setTimeout(tick, Math.max(0, nextAt - Date.now()));
    };
    tick();
    return () => clearTimeout(timer);
  };
  let pumpStop = (): void => {};

  /** Queue one turn and wait for it to finish going out at real time. */
  const playTurn = async (pcm: Int16Array): Promise<void> => {
    const frames: Int16Array[] = [];
    for (let off = 0; off < pcm.length; off += FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES);
      frame.set(pcm.subarray(off, Math.min(off + FRAME_SAMPLES, pcm.length)));
      frames.push(frame);
    }
    pending = frames;
    while (pending.length > 0 && ws.readyState === WebSocket.OPEN) await sleep(20);
    // Let the tail of the last frame actually leave.
    await sleep(FRAME_MS * 2);
  };

  /**
   * Wait until the agent has been quiet for `gapMs`. If it never says anything at
   * all, give up quickly rather than holding the turn open — a mute agent is the
   * failure we are trying to see, not something to wait out.
   */
  const waitForQuiet = async (): Promise<void> => {
    const startedAt = Date.now();
    const deadline = startedAt + 20_000;
    while (Date.now() < deadline) {
      await sleep(100);
      if (ws.readyState !== WebSocket.OPEN) return;
      if (lastInboundAt > startedAt) {
        if (Date.now() - lastInboundAt > opts.gapMs) return;
      } else if (Date.now() - startedAt > 5_000) {
        return;
      }
    }
  };

  try {
    pumpStop = startPump();
    if (opts.bargeIn) {
      // Talk over the greeting on purpose: the agent should stop mid-word and
      // the queued frames it had not sent yet should never arrive.
      await sleep(600);
      await playTurn(turns[0]!);
      const before = report.framesReceived;
      await sleep(1_000);
      console.log(
        `[${index}] barge-in: ${report.framesReceived - before} frames arrived in the second after we cut in, ${report.clears} clear(s) seen`,
      );
      turns = turns.slice(1);
    } else {
      // Let the agent get its greeting out first.
      await waitForQuiet();
    }

    for (const turn of turns) {
      if (ws.readyState !== WebSocket.OPEN) break;
      await playTurn(turn);
      await waitForQuiet();
    }

    pumpStop();
    send({ event: 'stop', sequenceNumber: String(seq++), streamSid, stop: { callSid: callId } });
    await sleep(300);
    ws.close();
    report.ok = true;
  } catch (err) {
    report.error = String(err);
    pumpStop();
    ws.close();
  }

  await Promise.race([closed, sleep(5_000)]);

  if (received.length > 0) {
    await mkdir(opts.outDir, { recursive: true });
    report.outPath = join(opts.outDir, `harness-${callId}.wav`);
    await writeWav(report.outPath, Int16Array.from(received), SAMPLE_RATE);
  }
  return report;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const dir = await mkdtemp(join(tmpdir(), 'el-turno-harness-'));

  try {
    console.log(`[harness] ${opts.count} call(s) to ${opts.url}`);
    const turns = await buildTurns(opts, dir);
    const totalMs = turns.reduce((n, t) => n + (t.length / SAMPLE_RATE) * 1000, 0);
    console.log(`[harness] caller script: ${turns.length} turn(s), ${(totalMs / 1000).toFixed(1)}s of audio`);

    const reports = await Promise.all(
      Array.from({ length: opts.count }, (_, i) => runCall(opts, turns, i)),
    );

    console.log('\n--- results ---');
    for (const [i, r] of reports.entries()) {
      const first = r.msToFirstAudio === undefined ? 'NO AUDIO' : `${r.msToFirstAudio}ms`;
      console.log(
        `[${i}] ${r.ok ? 'ok ' : 'ERR'} ${r.callId} · sent ${r.framesSent} · got ${r.framesReceived} ` +
          `· first audio ${first} · clears ${r.clears}${r.error ? ` · ${r.error}` : ''}`,
      );
    }

    const silent = reports.filter((r) => r.framesReceived === 0);
    if (silent.length > 0) {
      // The harness cuts a call with no audible audio from the agent and
      // attributes the failure to us, so this is the one that must be zero.
      console.log(`\nFAIL: ${silent.length}/${reports.length} call(s) produced no agent audio`);
      process.exitCode = 1;
    } else {
      console.log(`\nall ${reports.length} call(s) produced agent audio; WAVs in ${opts.outDir}/`);
    }
    console.log('Check the submissions in the call log: jq . calls/calls-*.jsonl | tail -40');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error('[harness] failed', err);
  process.exit(1);
});
