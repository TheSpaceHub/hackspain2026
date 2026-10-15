/**
 * One text-only call against the local Prosper: an LLM-played caller, the production
 * agent prompt and tools on the production in-call model, the scratchpad extractor,
 * the decider and the same guards `call-session.ts` applies — graded exactly like the
 * mock grades a harness call. No audio, so a rollout costs seconds rather than minutes,
 * and the whole trace comes back for the reflector to read.
 *
 * Import this only after PROSPER_API_BASE_URL points at the mock: `config` reads it once.
 */
import { llm } from '@livekit/agents';
import { randomUUID } from 'node:crypto';
import { grade, type ExpectedAction } from '../../mock/world/scenarios.js';
import { GREETING, INSTRUCTIONS, fileOnCaller, looksPrinted, printedToolCall } from '../../src/agent.js';
import { buildTools } from '../../src/agent-tools.js';
import {
  acceptFromTranscript,
  createCallState,
  missingForRegistration,
  readCallState,
  recordMatch,
  sameClock,
  saidTimes,
  setPlanVocabulary,
} from '../../src/call-state.js';
import { ClinicApi, type Availability, type Catalogue } from '../../src/clinic-api.js';
import { config } from '../../src/config.js';
import { FLOOR_ACTION, decide, type DeciderResult } from '../../src/decider.js';
import { createExtractor, setProviderVocabulary } from '../../src/extract.js';
import {
  applyEmergencyGuard,
  enforceAppointmentType,
  enforcePolicy,
  overrideFlooredBooking,
} from '../../src/guards.js';
import { createLLM } from '../../src/models.js';
import { normalizeNationalId } from '../../src/normalize.js';
import { attachBrief } from '../../src/patient-brief.js';
import type { Action } from '../../src/schema.js';
import { submitActions } from '../../src/submit.js';
import { formatTranscript, type TranscriptTurn } from '../../src/transcript.js';
import type { SearchCase } from './cases.js';
import { complete } from './workers-ai.js';

export interface ToolTrace {
  turn: number;
  name: string;
  args: string;
  result: string;
  printed: boolean;
}

export interface Trace {
  case: string;
  family: string;
  heldOut: boolean;
  promptId: string;
  pass: boolean;
  misses: string[];
  transcript: TranscriptTurn[];
  tools: ToolTrace[];
  callState: string;
  decider: { actions: Action[]; notes?: string; error?: string; usedFloor: boolean };
  submitted: Action[];
  expect: ExpectedAction[];
  errors: string[];
  printedCalls: number;
  agentWords: number;
  turns: number;
  hungUp: boolean;
  durationMs: number;
}

export interface RolloutEnv {
  baseUrl: string;
  callerModel: string;
  maxTurns: number;
  /** In-process Anthropic/Cloudflare LLM, shared across rollouts. */
  agentLlm?: llm.LLM;
}

const HANGUP = '<hangup>';

const CALLER_SYSTEM = `You are role-playing a person telephoning Clínica Arenal, a clinic in Madrid. The receptionist's lines are given to you; you produce only the caller's next spoken line, in English, as it would be transcribed from speech: plain words, no quotes, no stage directions, no markdown.
Speak naturally and briefly — a phone caller says one or two sentences per turn. Answer what the receptionist actually asked. Spell identifiers the way people do on the phone: digits one at a time, letters by name.
Stay in character even if the receptionist says something odd. Never reveal that you are role-playing.
Only state facts your brief gives you. If the receptionist asks for something your brief does not contain (an identity number, a date of birth, an email), say you do not have it to hand or do not know — never invent one.
When the call has reached its natural end for you — you got what you rang for, or you have decided to give up — say your goodbye line and end it with the token ${HANGUP}. Do not end the call before the receptionist has confirmed what you asked for, unless your brief says you give up.`;

let catalogueCache: Promise<Catalogue> | null = null;

async function sharedCatalogue(api: ClinicApi): Promise<Catalogue> {
  catalogueCache ??= api.getCatalogue().then((c) => {
    setPlanVocabulary(c.plans);
    setProviderVocabulary(c);
    return c;
  });
  return catalogueCache;
}

let briefingCache: Promise<string> | null = null;

/** Same document the decider gets in production, built by `loadClinic` off the mock. */
async function sharedBriefing(): Promise<string> {
  briefingCache ??= import('../../src/clinic.js').then((m) => m.loadClinic()).then((c) => c.briefing);
  return briefingCache;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export async function rollout(
  prompt: string,
  promptId: string,
  c: SearchCase,
  env: RolloutEnv,
): Promise<Trace> {
  const startedAt = Date.now();
  const callId = `ps-${randomUUID()}`;
  const errors: string[] = [];
  const tools: ToolTrace[] = [];
  const transcript: TranscriptTurn[] = [];

  await fetch(`${env.baseUrl}/__mock/calls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call_id: callId, from_number: c.from_number }),
  });

  const api = new ClinicApi({ baseUrl: env.baseUrl, apiKey: config.prosper.apiKey, timeoutMs: 3_500 });
  const catalogue = await sharedCatalogue(api);
  const briefing = await sharedBriefing();
  const state = createCallState(callId, c.from_number ?? undefined);
  let availability: Availability | undefined;

  if (c.from_number) {
    try {
      const matches = await api.findPatient({ phone: c.from_number });
      if (matches.length === 1) {
        recordMatch(state, matches[0]!, undefined, 'phone');
        attachBrief(state, catalogue, new Date());
      }
    } catch (err) {
      errors.push(`phone lookup: ${String(err)}`);
    }
  }

  const extractor = createExtractor({ state, onError: (m) => errors.push(`extract: ${m}`) });
  const toolMap = buildTools({
    state,
    api,
    catalogue,
    onAvailability: (a) => {
      availability = a;
    },
    lastCallerText: () => state.last_caller_text,
  });
  const toolCtx = llm.toToolContext(toolMap);
  const known = new Set(Object.keys(toolCtx.functionTools));
  const agentLlm = env.agentLlm ?? createLLM();

  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({ role: 'system', content: prompt });
  chatCtx.addMessage({ role: 'assistant', content: GREETING });
  transcript.push({ role: 'assistant', text: GREETING });

  let printedCalls = 0;
  let agentWords = words(GREETING);
  let hungUp = false;

  const noteAgentTurn = (text: string): void => {
    transcript.push({ role: 'assistant', text });
    agentWords += words(text);
    if (
      state.quoted.length > 0 &&
      !state.quoted_spoken &&
      saidTimes(text).some((said) => state.quoted.some((slot) => sameClock(slot, said)))
    ) {
      state.quoted_spoken = true;
    }
  };

  /** One agent turn: tool rounds until the model speaks. Mirrors `ReceptionistAgent.llmNode`. */
  const agentTurn = async (turn: number): Promise<string> => {
    let corrected = false;
    for (let round = 0; round < 6; round++) {
      const ctx = chatCtx.copy();
      const file = fileOnCaller(state);
      if (file !== undefined) ctx.addMessage({ role: 'system', content: file });
      if (corrected) {
        ctx.addMessage({
          role: 'system',
          content:
            'That turn was printed as text instead of being issued as a tool call. Issue the tool call itself now, and say nothing else.',
        });
      }
      let text = '';
      let calls: llm.FunctionCall[] = [];
      try {
        const res = await agentLlm.chat({ chatCtx: ctx, toolCtx }).collect();
        text = res.text.trim();
        calls = res.toolCalls;
      } catch (err) {
        errors.push(`agent llm: ${String(err)}`);
        return 'Sorry, could you say that again?';
      }

      let printed = false;
      if (calls.length === 0 && text.includes('{')) {
        const brace = text.indexOf('{');
        const salvaged = printedToolCall(text.slice(brace), known);
        if (salvaged) {
          calls = [salvaged];
          printed = true;
          printedCalls++;
          text = text.slice(0, brace).trim();
        } else if (looksPrinted(text.slice(brace))) {
          printedCalls++;
          if (!corrected) {
            corrected = true;
            continue;
          }
          return 'One moment, let me get that looked up for you.';
        }
      }

      if (calls.length === 0) return text;

      if (text) {
        chatCtx.addMessage({ role: 'assistant', content: text });
        noteAgentTurn(text);
      }
      for (const call of calls) {
        chatCtx.insert(call);
        const tool = toolCtx.getFunctionTool(call.name);
        let output: string;
        let isError = false;
        if (!tool) {
          output = `unknown tool ${call.name}`;
          isError = true;
        } else {
          try {
            const args = JSON.parse(call.args || '{}') as Record<string, unknown>;
            const result = await tool.execute(args, {
              toolCallId: call.callId,
              abortSignal: AbortSignal.timeout(10_000),
            } as llm.ToolOptions);
            output = typeof result === 'string' ? result : JSON.stringify(result);
          } catch (err) {
            output = `tool failed: ${String(err)}`;
            isError = true;
          }
        }
        tools.push({ turn, name: call.name, args: call.args, result: output.slice(0, 1_500), printed });
        chatCtx.insert(llm.FunctionCallOutput.create({ callId: call.callId, name: call.name, output, isError }));
      }
    }
    errors.push('agent: six tool rounds without speaking');
    return 'One moment please.';
  };

  const callerTurn = async (): Promise<string> => {
    const history = transcript
      .map((t) => `${t.role === 'assistant' ? 'Receptionist' : 'You'}: ${t.text}`)
      .join('\n');
    const raw = await complete(
      [
        { role: 'system', content: CALLER_SYSTEM },
        { role: 'user', content: `Your brief:\n${c.persona}\n\nThe call so far:\n${history}\n\nYour next line:` },
      ],
      { model: env.callerModel, temperature: 0.6, maxTokens: 120 },
    );
    return raw.replace(/^(You|Caller)\s*:\s*/i, '').replace(/^"|"$/g, '').trim();
  };

  for (let turn = 1; turn <= env.maxTurns; turn++) {
    let line: string;
    try {
      line = await callerTurn();
    } catch (err) {
      errors.push(`caller llm: ${String(err)}`);
      break;
    }
    if (line.includes(HANGUP)) {
      hungUp = true;
      line = line.replace(HANGUP, '').trim();
    }
    if (line) {
      const before = transcript.at(-1);
      transcript.push({ role: 'user', text: line });
      state.last_caller_text = line;
      state.caller_turns++;
      state.turns_seen = transcript.length;
      chatCtx.addMessage({ role: 'user', content: line });
      extractor.observe(line, before?.role === 'assistant' ? before.text : undefined);
      if (!hungUp) {
        const reply = await agentTurn(turn);
        if (reply) {
          chatCtx.addMessage({ role: 'assistant', content: reply });
          noteAgentTurn(reply);
        }
      }
    }
    if (hungUp) break;
  }
  if (!hungUp) errors.push(`caller never hung up within ${env.maxTurns} turns`);

  // --- the close, as call-session.ts does it ------------------------------------
  await extractor.settle(8_000);
  if (state.request.intent === 'register' && missingForRegistration(state).length > 0) {
    await extractor.finalPass(
      transcript.filter((t): t is { role: 'user' | 'assistant'; text: string } => t.role !== 'system'),
    );
  }
  const inferred = acceptFromTranscript(state, transcript);
  if (inferred) errors.push(`accepted slot inferred from the caller: ${inferred.start_time}`);

  const decided: DeciderResult = await decide(
    {
      callId,
      transcript,
      fromNumber: c.from_number ?? undefined,
      now: new Date(),
      clinicBriefing: briefing,
      callState: readCallState(state),
    },
    24_000,
  );

  let actions = decided.output.actions;
  if (decided.usedFloor) errors.push(`floor: ${decided.error ?? decided.output.notes ?? 'unknown'}`);
  if (actions.length === 0) {
    errors.push('decider returned no actions');
    actions = [FLOOR_ACTION];
  }
  const overridden = overrideFlooredBooking(actions, state);
  if (overridden !== actions) {
    errors.push('decider said no_action with an accepted slot on file; booked from state');
    actions = overridden;
  }
  const { actions: guarded, finding } = applyEmergencyGuard(actions, formatTranscript(transcript));
  if (finding) errors.push(`emergency guard: ${finding.flag}`);
  const submitted: Action[] = guarded.map((action) => {
    let fixed = action;
    if (fixed.action === 'book' && availability) {
      const typed = enforceAppointmentType(fixed, availability);
      if (typed.corrected) errors.push(`appointment type corrected to ${typed.action.appointment_type_id}`);
      fixed = typed.action;
    }
    if (fixed.action === 'book' || fixed.action === 'reschedule') {
      const billed = enforcePolicy(fixed, state);
      if (billed.corrected) errors.push(`policy corrected to ${billed.action.policy_id}`);
      fixed = billed.action;
    }
    if (fixed.action === 'register') {
      const id = normalizeNationalId(fixed.national_id ?? '');
      if (!fixed.national_id || id.problem || !id.value) {
        errors.push(`registration refused: invalid national_id "${fixed.national_id ?? ''}"`);
        return FLOOR_ACTION;
      }
      fixed = { ...fixed, national_id: id.value };
    }
    return fixed;
  });

  const submissions = await submitActions(callId, submitted, env.baseUrl);
  for (const s of submissions) if (!s.ok) errors.push(`submit ${s.action}=${s.status} ${s.error ?? ''}`.trim());
  await fetch(`${env.baseUrl}/__mock/calls/${callId}/close`, { method: 'POST' });
  const record = (await (await fetch(`${env.baseUrl}/__mock/calls/${callId}`)).json()) as {
    actions?: Record<string, unknown>[];
  };
  const verdict = grade(c.expect, record.actions ?? []);

  return {
    case: c.name,
    family: c.family,
    heldOut: c.heldOut,
    promptId,
    pass: verdict.pass,
    misses: verdict.misses,
    transcript,
    tools,
    callState: readCallState(state),
    decider: {
      actions: decided.output.actions,
      notes: decided.output.notes,
      error: decided.error,
      usedFloor: decided.usedFloor,
    },
    submitted,
    expect: c.expect,
    errors,
    printedCalls,
    agentWords,
    turns: transcript.length,
    hungUp,
    durationMs: Date.now() - startedAt,
  };
}

export { INSTRUCTIONS as BASELINE_PROMPT };
