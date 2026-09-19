/**
 * A local stand-in for the Prosper harness: dials your own /ws on the same wire, plays a
 * scripted caller, records what comes back. Debug here, not on rate-limited practice calls.
 *
 *   pnpm harness                              scripted booking call, one socket
 *   pnpm harness -- --n 10                    ten concurrent calls, the Run All shape
 *   pnpm harness -- --n 20                    the Switchboard burst
 *   pnpm harness -- --scenario all --parallel 3  graded cases with three callers at once
 *   pnpm harness -- --barge-in                talk over the agent's greeting
 *   pnpm harness -- --wav caller.wav          play a real recording instead
 *   pnpm harness -- --say "hello" --say "..."  synthesise lines (`say` on macOS, `espeak-ng` on Linux)
 *
 * Against the local Prosper (pnpm mock), each call is announced to it the way the
 * real harness knows about the calls it dials, and graded against a local case:
 *
 *   pnpm harness:local -- --scenario simple      one case, PASS/FAIL on the record
 *   pnpm harness:local -- --scenario all         every case at once
 *   pnpm harness:sim -- --scenario all           graded cases on the snapshot clinic
 *   pnpm harness -- --prosper http://127.0.0.1:8787 --scenario cancel
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { mulawToPcm16, pcm16ToMulaw } from '../src/mulaw.js';
import { readWav, toMono, writeWav } from './wav.js';

if (existsSync('.env')) process.loadEnvFile('.env');

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
  /** The local Prosper mock; unset means calls are not announced or graded. */
  prosper?: string;
  /** Local cases to play, by name; `all` for every one. Needs `prosper`. */
  scenarios: string[];
  /** Maximum number of calls running at once. */
  parallel: number;
}

/** One call's worth: what the caller says and who they appear to be. */
interface CallPlan {
  turns: Int16Array[];
  /** E.164, or null for a withheld number. */
  fromNumber: string | null;
  scenario: string | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    url: process.env.HARNESS_URL ?? 'ws://127.0.0.1:7860/ws',
    count: 1,
    script: [],
    bargeIn: false,
    gapMs: 900,
    outDir: './calls',
    prosper: process.env.MOCK_PROSPER_URL,
    scenarios: [],
    parallel: 3,
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
    else if (arg === '--prosper' && next) opts.prosper = argv[++i]!;
    else if (arg === '--scenario' && next) opts.scenarios.push(argv[++i]!);
    else if (arg === '--parallel' && next) opts.parallel = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--barge-in') opts.bargeIn = true;
  }
  if (opts.script.length === 0) opts.script = DEFAULT_SCRIPT;
  if (opts.scenarios.length > 0 && !opts.prosper) {
    throw new Error('--scenario needs the local Prosper: pass --prosper <url> or set MOCK_PROSPER_URL');
  }
  if (opts.prosper) opts.prosper = opts.prosper.replace(/\/+$/, '');
  return opts;
}

let warnedSilence = false;
let warnedDeepgram = false;

async function synthesiseDeepgram(line: string, lang: 'en' | 'es', wav: string): Promise<Int16Array | undefined> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return undefined;
  const voice = lang === 'es' ? 'aura-2-celeste-es' : 'aura-2-luna-en';
  const cacheDir = join(homedir(), '.cache', 'harness-tts');
  const hash = createHash('sha256').update(`${voice}\0${line}`).digest('hex');
  const cached = join(cacheDir, `${hash}.wav`);
  try {
    await mkdir(cacheDir, { recursive: true });
    const bytes = await readFile(cached).catch(async () => {
      const url =
        `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}` +
        '&encoding=linear16&sample_rate=8000&container=wav';
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line }),
      });
      if (!response.ok) throw new Error(`Deepgram TTS ${voice} → ${response.status}: ${await response.text()}`);
      const body = Buffer.from(await response.arrayBuffer());
      await writeFile(cached, body);
      return body;
    });
    await writeFile(wav, bytes);
    return toMono(await readWav(wav), SAMPLE_RATE);
  } catch (err) {
    if (!warnedDeepgram) {
      warnedDeepgram = true;
      console.warn(`[harness] Deepgram caller TTS failed; falling back to local speech: ${String(err)}`);
    }
    return undefined;
  }
}

/**
 * macOS `say`; on Linux `espeak-ng`, fully offline. Without either, silence of a
 * plausible length still exercises pacing — but the agent hears no caller, so the
 * store gets no user turns.
 */
async function synthesise(line: string, dir: string, name: string, lang: 'en' | 'es' = 'en'): Promise<Int16Array> {
  const wav = join(dir, `${name}.wav`);
  if (process.platform === 'darwin') {
    // CoreAudio downsamples properly, giving real phone-line band-limiting.
    await exec('say', ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@8000', line]);
    return toMono(await readWav(wav), SAMPLE_RATE);
  }
  const deepgram = await synthesiseDeepgram(line, lang, wav);
  if (deepgram) return deepgram;
  const voice = ['-v', 'en-us', '-s', '150'];
  try {
    // 22.05 kHz out; toMono brings it down to the wire's 8 kHz.
    await exec('espeak-ng', [...voice, '-w', wav, line]);
    return toMono(await readWav(wav), SAMPLE_RATE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    // Inside a flatpak (VS Code's terminal, say) the host's espeak-ng is out of sight,
    // and so is its /tmp — so ask the host for the audio on stdout instead of a file.
    if (!process.env.FLATPAK_ID) throw Object.assign(new Error('not in a flatpak'), { code: 'ENOENT' });
    const { stdout } = await exec('flatpak-spawn', ['--host', 'espeak-ng', ...voice, '--stdout', line], {
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    });
    await writeFile(wav, stdout);
    return toMono(await readWav(wav), SAMPLE_RATE);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // flatpak-spawn exits non-zero when the host has no espeak-ng either.
    if (code !== 'ENOENT' && typeof code !== 'number') throw err;
    if (!warnedSilence) {
      warnedSilence = true;
      console.warn('[harness] espeak-ng not found — the caller will be silent (dnf install espeak-ng)');
    }
    return new Int16Array(Math.round((SAMPLE_RATE * (1.5 + line.length / 15)) | 0));
  }
}

async function synthesiseScript(lines: string[], dir: string, prefix: string, lang: 'en' | 'es' = 'en'): Promise<Int16Array[]> {
  const turns: Int16Array[] = [];
  for (const [i, line] of lines.entries()) {
    const pause = /^\[pause (\d+(?:\.\d+)?)\]$/i.exec(line.trim());
    turns.push(
      pause ? new Int16Array(Math.round(SAMPLE_RATE * Number(pause[1]))) : await synthesise(line, dir, `${prefix}-${i}`, lang),
    );
  }
  return turns;
}

// --- the local Prosper --------------------------------------------------------

interface MockScenario {
  name: string;
  problem: string;
  summary: string;
  lang?: 'en' | 'es';
  from_number: string | null;
  script: string[];
}

interface MockCall {
  actions: { action: string }[];
  last_received_at: string | null;
  window_open: boolean;
  verdict: { pass: boolean; misses: string[]; final: boolean } | null;
}

async function mockGet<T>(opts: Options, path: string): Promise<T> {
  const res = await fetch(`${opts.prosper}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Tell the mock a call exists — on the real platform, dialling it is what does this. */
async function mockPost(opts: Options, path: string, body?: unknown): Promise<void> {
  if (!opts.prosper) return;
  try {
    await fetch(`${opts.prosper}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[harness] local Prosper unreachable at ${opts.prosper}: ${String(err)}`);
  }
}

/**
 * The record once it has settled: either the window has shut, or something arrived
 * and nothing more has for a few seconds. A call that submits nothing waits the full
 * window, because that silence is itself the verdict.
 */
async function awaitRecord(opts: Options, callId: string): Promise<MockCall | null> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const call = await mockGet<MockCall>(opts, `/__mock/calls/${callId}`).catch(() => null);
    if (!call) return null;
    const settled = call.last_received_at !== null && Date.now() - Date.parse(call.last_received_at) > 3_000;
    if (!call.window_open || settled) return call;
    await sleep(1_000);
  }
  return mockGet<MockCall>(opts, `/__mock/calls/${callId}`).catch(() => null);
}

async function buildPlans(opts: Options, dir: string): Promise<CallPlan[]> {
  const byIndex = (i: number): string => `+3461234${String(5000 + i).slice(-4)}`;

  if (opts.scenarios.length > 0) {
    const all = opts.scenarios.includes('all');
    const wanted = all
      ? (await mockGet<{ scenarios: MockScenario[] }>(opts, '/__mock/scenarios')).scenarios
      : await Promise.all(opts.scenarios.map((n) => mockGet<MockScenario>(opts, `/__mock/scenarios/${n}`)));
    const plans: CallPlan[] = [];
    for (const s of wanted) {
      const turns = await synthesiseScript(s.script, dir, s.name, s.lang ?? 'en');
      console.log(`[harness] ${s.name.padEnd(12)} ${s.problem} — ${s.summary}`);
      for (let i = 0; i < opts.count; i++) plans.push({ turns, fromNumber: s.from_number, scenario: s.name });
    }
    return plans;
  }

  const turns = opts.wav
    ? [toMono(await readWav(opts.wav), SAMPLE_RATE)]
    : await synthesiseScript(opts.script, dir, 'line');
  return Array.from({ length: opts.count }, (_, i) => ({ turns, fromNumber: byIndex(i), scenario: null }));
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

async function runCall(opts: Options, plan: CallPlan, index: number): Promise<CallReport> {
  const callId = randomUUID();
  const streamSid = `MZ${randomUUID().replace(/-/g, '')}`.slice(0, 34);
  const { fromNumber } = plan;
  let turns = plan.turns;
  const report: CallReport = { callId, ok: false, framesSent: 0, framesReceived: 0, clears: 0 };

  const received: number[] = [];
  let lastInboundAt = 0;
  let openedAt = 0;

  // Announced before dialling, so a submission can never beat its own call to the mock.
  await mockPost(opts, '/__mock/calls', { call_id: callId, scenario: plan.scenario, from_number: fromNumber });
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
      // Absent, not empty, when the caller id is withheld — as on the real wire.
      customParameters: fromNumber ? { call_id: callId, from_number: fromNumber } : { call_id: callId },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: SAMPLE_RATE, channels: 1 },
    },
  });

  // A phone line always sends. STT endpointing needs to hear the silence between
  // turns; a harness that just stops sending never lets an utterance close.
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

  /** Starts the line; returns its stop. */
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

  /** Queue a turn and wait for it to go out at real time. */
  const playTurn = async (pcm: Int16Array): Promise<void> => {
    const frames: Int16Array[] = [];
    for (let off = 0; off < pcm.length; off += FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES);
      frame.set(pcm.subarray(off, Math.min(off + FRAME_SAMPLES, pcm.length)));
      frames.push(frame);
    }
    pending = frames;
    while (pending.length > 0 && ws.readyState === WebSocket.OPEN) await sleep(20);
    // Let the last frame's tail leave.
    await sleep(FRAME_MS * 2);
  };

  /** Wait for `gapMs` of quiet. A mute agent is the failure we want to see, not wait out. */
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
      // Talk over the greeting: queued frames should never arrive.
      await sleep(600);
      await playTurn(turns[0]!);
      const before = report.framesReceived;
      await sleep(1_000);
      console.log(
        `[${index}] barge-in: ${report.framesReceived - before} frames arrived in the second after we cut in, ${report.clears} clear(s) seen`,
      );
      turns = turns.slice(1);
    } else {
      // Let the greeting out first.
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
  // The 30 s submission window starts now.
  await mockPost(opts, `/__mock/calls/${callId}/close`);

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
    const plans = await buildPlans(opts, dir);
    console.log(`[harness] ${plans.length} call(s) to ${opts.url}${opts.prosper ? ` · local Prosper ${opts.prosper}` : ''}`);
    const totalMs = plans[0]!.turns.reduce((n, t) => n + (t.length / SAMPLE_RATE) * 1000, 0);
    console.log(`[harness] caller script: ${plans[0]!.turns.length} turn(s), ${(totalMs / 1000).toFixed(1)}s of audio`);

    const reports: CallReport[] = Array.from({ length: plans.length });
    let nextPlan = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextPlan++;
        if (i >= plans.length) return;
        reports[i] = await runCall(opts, plans[i]!, i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.parallel, plans.length) }, () => worker()));

    console.log('\n--- results ---');
    for (const [i, r] of reports.entries()) {
      const first = r.msToFirstAudio === undefined ? 'NO AUDIO' : `${r.msToFirstAudio}ms`;
      console.log(
        `[${i}] ${r.ok ? 'ok ' : 'ERR'} ${r.callId} · sent ${r.framesSent} · got ${r.framesReceived} ` +
          `· first audio ${first} · clears ${r.clears}${r.error ? ` · ${r.error}` : ''}`,
      );
    }

    if (opts.prosper) {
      console.log('\n--- records (local Prosper) ---');
      const records = await Promise.all(reports.map((r) => awaitRecord(opts, r.callId)));
      let graded = 0;
      let passed = 0;
      for (const [i, rec] of records.entries()) {
        const plan = plans[i]!;
        const actions = rec?.actions.map((a) => JSON.stringify(a)).join(' + ') || 'nothing submitted';
        if (rec?.verdict) {
          graded++;
          if (rec.verdict.pass) passed++;
          console.log(`[${i}] ${rec.verdict.pass ? 'PASS' : 'FAIL'} ${plan.scenario} · ${actions}`);
          for (const miss of rec.verdict.misses) console.log(`      ${miss}`);
        } else {
          console.log(`[${i}] ${actions}`);
        }
      }
      if (graded > 0) {
        console.log(`\n${passed}/${graded} case(s) passed`);
        if (passed < graded) process.exitCode = 1;
      }
    }

    const silent = reports.filter((r) => r.framesReceived === 0);
    if (silent.length > 0) {
      // The harness cuts a silent call and blames us, so this must be zero.
      console.log(`\nFAIL: ${silent.length}/${reports.length} call(s) produced no agent audio`);
      process.exitCode = 1;
    } else {
      console.log(`\nall ${reports.length} call(s) produced agent audio; WAVs in ${opts.outDir}/`);
    }
    if (!opts.prosper) console.log('Check the submissions in the call log: jq . calls/calls-*.jsonl | tail -40');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error('[harness] failed', err);
  process.exit(1);
});
