/**
 * One call, on the same wire the platform uses: a Twilio-shaped media stream to
 * the agent's /ws, the caller's speech paced at 20 ms, silence between turns so
 * endpointing can close an utterance, and the agent's audio kept for the record.
 */
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { mulawToPcm16, pcm16ToMulaw } from '../src/mulaw.js';
import { writeWav } from '../test/wav.js';
import type { Case } from '../mock/world/suite/types.js';
import { mix, SAMPLE_RATE, say, silence } from './audio.js';
import type { Behaviour } from './behaviour.js';
import { callerFor } from './caller.js';
import type { Vocabulary } from './vocabulary.js';
import type { AgentFeed, Turn } from './feed.js';

const FRAME_SAMPLES = 160;
const FRAME_MS = 20;

export interface DialOptions {
  agentWs: string;
  mockUrl: string;
  kase: Case;
  mode: 'script' | 'persona';
  behaviour: Behaviour;
  vocabulary: Vocabulary;
  feed: AgentFeed;
  outDir: string;
  /** Distinguishes the calls of a Switchboard burst from one another. */
  copy: number;
}

export interface CallOutcome {
  call_id: string;
  from_number: string | null;
  ok: boolean;
  error?: string;
  frames_sent: number;
  frames_received: number;
  ms_to_first_audio: number | null;
  clears: number;
  caller: 'script' | 'persona';
  behaviour: string;
  vocabulary: string;
  /** What the caller agent was told to be, kept so a strange call can be read back. */
  caller_prompt: string | null;
  caller_turns: string[];
  transcript: Turn[];
  wav_path: string | null;
  call_ms: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function announce(mockUrl: string, path: string, body?: unknown): Promise<void> {
  try {
    await fetch(`${mockUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[testlab] local Prosper unreachable: ${String(err)}`);
  }
}

export async function dial(opts: DialOptions): Promise<CallOutcome> {
  const { kase, feed, behaviour } = opts;
  const callId = randomUUID();
  const streamSid = `MZ${randomUUID().replace(/-/g, '')}`.slice(0, 34);
  const fromNumber = kase.from_number;
  const caller = callerFor(kase, opts.mode, behaviour, opts.vocabulary);
  const voice = {
    language: kase.language,
    sex: kase.persona.voice,
    wpm: behaviour.wpm,
    gain: behaviour.gain,
  };
  // The behaviour's own room wins: "ringing from a motorway" is the point of it.
  const bedOf = behaviour.audio ?? kase.audio;

  const outcome: CallOutcome = {
    call_id: callId,
    from_number: fromNumber,
    ok: false,
    frames_sent: 0,
    frames_received: 0,
    ms_to_first_audio: null,
    clears: 0,
    caller: caller.kind,
    behaviour: behaviour.id,
    vocabulary: opts.vocabulary.id,
    caller_prompt: caller.prompt,
    caller_turns: [],
    transcript: [],
    wav_path: null,
    call_ms: 0,
  };

  if (caller.prompt !== null) {
    console.log(
      `[testlab] ${kase.id} ${callId} caller ${behaviour.id} / ${opts.vocabulary.id}\n${caller.prompt}\n`,
    );
  }

  const received: number[] = [];
  let lastInboundAt = 0;
  const startedAt = Date.now();

  // Announced before dialling, so a submission can never beat its own call to the mock.
  await announce(opts.mockUrl, '/__mock/calls', { call_id: callId, from_number: fromNumber });

  const ws = new WebSocket(opts.agentWs);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const openedAt = Date.now();

  ws.on('message', (data) => {
    let msg: { event?: string; media?: { payload?: string } };
    try {
      msg = JSON.parse(String(data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.event === 'media' && msg.media?.payload) {
      outcome.frames_received++;
      outcome.ms_to_first_audio ??= Date.now() - openedAt;
      lastInboundAt = Date.now();
      for (const s of mulawToPcm16(Buffer.from(msg.media.payload, 'base64'))) received.push(s);
    } else if (msg.event === 'clear') {
      outcome.clears++;
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
      accountSid: 'ACtestlab',
      callSid: callId,
      tracks: ['inbound'],
      customParameters: fromNumber ? { call_id: callId, from_number: fromNumber } : { call_id: callId },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: SAMPLE_RATE, channels: 1 },
    },
  });

  // A phone line always sends, but it sends nothing: the room is only ever heard
  // under the caller's own words, never over the agent or into a gap in the call.
  const quiet = new Int16Array(SAMPLE_RATE);
  let bedAt = 0;
  let pending: Int16Array[] = [];

  const pumpFrame = (): void => {
    let frame = pending.shift();
    if (!frame) {
      frame = quiet.subarray(bedAt, bedAt + FRAME_SAMPLES) as Int16Array;
      bedAt = (bedAt + FRAME_SAMPLES) % (quiet.length - FRAME_SAMPLES);
    }
    send({
      event: 'media',
      sequenceNumber: String(seq++),
      streamSid,
      media: {
        track: 'inbound',
        chunk: String(seq),
        timestamp: String(outcome.frames_sent * FRAME_MS),
        payload: Buffer.from(pcm16ToMulaw(frame)).toString('base64'),
      },
    });
    outcome.frames_sent++;
  };

  let timer: NodeJS.Timeout | undefined;
  const startPump = (): void => {
    let nextAt = Date.now();
    const tick = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      pumpFrame();
      nextAt += FRAME_MS;
      timer = setTimeout(tick, Math.max(0, nextAt - Date.now()));
    };
    tick();
  };

  const playTurn = async (pcm: Int16Array): Promise<void> => {
    const frames: Int16Array[] = [];
    for (let off = 0; off < pcm.length; off += FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES);
      frame.set(pcm.subarray(off, Math.min(off + FRAME_SAMPLES, pcm.length)));
      frames.push(frame);
    }
    pending = frames;
    while (pending.length > 0 && ws.readyState === WebSocket.OPEN) await sleep(20);
    await sleep(FRAME_MS * 2);
  };

  /** Wait out the agent's reply: quiet on the line, or its turn written down. */
  const waitForQuiet = async (): Promise<void> => {
    const from = Date.now();
    const deadline = from + 20_000;
    while (Date.now() < deadline) {
      await sleep(100);
      if (ws.readyState !== WebSocket.OPEN) return;
      if (lastInboundAt > from) {
        if (Date.now() - lastInboundAt > 900) return;
      } else if (Date.now() - from > 5_000) {
        return;
      }
    }
  };

  try {
    startPump();
    // Someone who talks over people does not wait for the greeting either.
    if (behaviour.barge_in) await sleep(600);
    else await waitForQuiet();

    for (let turn = 0; turn < kase.persona.turn_cap; turn++) {
      if (ws.readyState !== WebSocket.OPEN) break;
      const heardBefore = Date.now();
      const line = await caller.next(feed.said(callId));
      if (line === null) break;
      outcome.caller_turns.push(line);
      // Dead air before the turn is still the line being held open, not a gap in it.
      if (behaviour.lead_ms > 0) await playTurn(silence(behaviour.lead_ms));
      await playTurn(mix(await say(line, voice), bedOf, 104729 + turn + opts.copy * 31));
      if (behaviour.tail_ms > 0) await playTurn(silence(behaviour.tail_ms));
      if (behaviour.barge_in) {
        // Cut in on whatever the agent is saying: just long enough to hear its shape.
        await Promise.race([feed.nextReply(callId, heardBefore, 6_000), sleep(2_500)]);
      } else {
        await Promise.race([waitForQuiet(), feed.nextReply(callId, heardBefore, 20_000)]);
        await waitForQuiet();
      }
    }

    clearTimeout(timer);
    send({ event: 'stop', sequenceNumber: String(seq++), streamSid, stop: { callSid: callId } });
    await sleep(300);
    ws.close();
    outcome.ok = true;
  } catch (err) {
    outcome.error = String(err);
    clearTimeout(timer);
    ws.close();
  }

  await Promise.race([closed, sleep(5_000)]);
  outcome.call_ms = Date.now() - startedAt;
  // The 30 s submission window starts now.
  await announce(opts.mockUrl, `/__mock/calls/${callId}/close`);
  outcome.transcript = feed.turns(callId);

  if (received.length > 0) {
    await mkdir(opts.outDir, { recursive: true });
    outcome.wav_path = join(opts.outDir, `${kase.id}-${callId}.wav`);
    await writeWav(outcome.wav_path, Int16Array.from(received), SAMPLE_RATE);
  }
  return outcome;
}
