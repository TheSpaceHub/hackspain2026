/**
 * Why a call failed, and what to do about it.
 *
 * The verdict already says which field of which action was wrong; that is a
 * diff, not a diagnosis. Here that diff is read against the transcript to name
 * the failure — the agent never asked for an identifier, it answered in the
 * wrong language, it read a national id back down the line — and the failures
 * that keep happening are gathered into one issue per problem rather than one
 * per call, because that is the shape of the fix.
 */
import type { Case, Grade } from '../mock/world/suite/types.js';
import { chat, llmAvailable } from './llm.js';
import type { CallOutcome } from './dial.js';

export type Severity = 'blocker' | 'major' | 'minor';

export interface Insight {
  code: string;
  severity: Severity;
  /** What went wrong, in the terms of this call. */
  detail: string;
  /** Why it went wrong: the mechanism behind the symptom. */
  why: string;
  suggestion: string;
  /** The turns the finding was read off, so the reader can see it for themselves. */
  evidence: string[];
}

export interface CaseResult {
  case_id: string;
  problem_id: string;
  title: string;
  behaviour: string;
  vocabulary: string;
  copy: number;
  pass: boolean;
  grade: Grade;
  actions: Record<string, unknown>[];
  leaked: string[];
  call: CallOutcome;
  insights: Insight[];
  /** Filled in afterwards, and only for failures, since it costs a model call. */
  summary?: string;
}

const ASKS_ID = /\b(dni|nie|identifi|documento|número de|passport|date of birth|fecha de nacimiento)\b/i;
const SPANISH = /\b(buenos|gracias|cita|tarde|puedo|usted|doctora|seguro|día)\b/i;
const CATALAN = /\b(bon dia|gràcies|visita|vostè|metge|dilluns|si us plau)\b/i;

/** One transcript turn, written the way a person reads a call. */
function line(t: { role: string; text: string }): string {
  return `${t.role === 'user' ? 'caller' : 'agent'}: ${t.text}`;
}

/** The turns around the first one that matches, or the end of the call if none does. */
function near(
  transcript: readonly { role: string; text: string }[],
  match: ((t: { role: string; text: string }) => boolean) | null,
  span = 4,
): string[] {
  if (transcript.length === 0) return [];
  const at = match ? transcript.findIndex(match) : -1;
  if (at === -1) return transcript.slice(-span).map(line);
  return transcript.slice(Math.max(0, at - 1), at + span - 1).map(line);
}

/** The wire names of the actions the platform records, as the suite writes them. */
function actionsOf(result: { actions: Record<string, unknown>[] }): string[] {
  return result.actions.map((a) => String(a.action ?? '?'));
}

export function insightsFor(kase: Case, result: Omit<CaseResult, 'insights'>): Insight[] {
  const found: Insight[] = [];
  const said = result.call.transcript.filter((t) => t.role === 'assistant').map((t) => t.text);
  const heard = result.call.transcript.filter((t) => t.role === 'user').map((t) => t.text);
  const wanted = kase.expected.acceptable[0]?.actions.map((a) => a.action) ?? [];
  const got = actionsOf(result);

  if (result.call.frames_received === 0) {
    found.push({
      code: 'mute',
      severity: 'blocker',
      detail: 'The agent sent no audio at all; the platform cuts a silent call and scores it against us.',
      why:
        'The socket opened and the caller spoke, so the leg was up — nothing was ever synthesised back down it. ' +
        'That is a TTS or greeting-path failure, not a decision the agent made.',
      suggestion: 'Check the TTS path and the greeting: first audio must leave inside a second of the socket opening.',
      evidence: near(result.call.transcript, null, 3),
    });
  } else if ((result.call.ms_to_first_audio ?? 0) > 2_000) {
    found.push({
      code: 'slow_greeting',
      severity: 'minor',
      detail: `First audio took ${result.call.ms_to_first_audio}ms.`,
      why: 'The greeting waits on the first model turn, so the caller hears dead air for as long as that turn takes.',
      suggestion: 'Send the greeting from a cached utterance rather than waiting on the first model turn.',
      evidence: result.call.transcript.slice(0, 2).map(line),
    });
  }

  if (heard.length === 0 && result.call.caller_turns.length > 0) {
    found.push({
      code: 'deaf',
      severity: 'blocker',
      detail: 'Nothing the caller said was transcribed — the agent heard none of the call.',
      why:
        `The caller took ${result.call.caller_turns.length} turns and not one came back from the recogniser, so every ` +
        'later decision was made on an empty conversation. Usually a language hint, an endpointing setting or the noise bed.',
      suggestion: 'Check STT: language hints, the endpointing model, and whether the noise bed is drowning the caller.',
      evidence: result.call.caller_turns.slice(0, 3).map((t) => `caller (spoken, never transcribed): ${t}`),
    });
  }

  if (result.leaked.length > 0) {
    found.push({
      code: 'privacy_leak',
      severity: 'blocker',
      detail: `Said something it was told to protect: ${result.leaked.join(', ')}.`,
      why:
        'The agent read a protected value back down the line to confirm it, before the caller had been established as ' +
        'the person entitled to hear it. Confirming by reading out is the leak.',
      suggestion: 'Never read an identifier, phone number or diary entry back to a caller who has not been identified as the patient.',
      evidence: near(result.call.transcript, (t) => t.role !== 'user' && result.leaked.some((l) => t.text.includes(l)), 3),
    });
  }

  if (result.actions.length === 0) {
    found.push({
      code: 'no_record',
      severity: 'blocker',
      detail: 'Nothing was submitted before the window shut.',
      why:
        said.length > 0
          ? 'The agent was still talking when the window shut: it treated the conversation as unfinished and so never ' +
            'committed a record, when an unfinished call should still be written up.'
          : 'The call produced no agent speech and no record, so the decider was never reached at all.',
      suggestion: 'The decider must always write a record: a refusal with a reason still scores, silence never does.',
      evidence: near(result.call.transcript, null),
    });
  } else if (wanted.length > 0 && got.join('+') !== wanted.join('+')) {
    found.push({
      code: 'wrong_action',
      severity: 'major',
      detail: `Submitted ${got.join(' + ')} where the case wants ${wanted.join(' + ')}.`,
      why:
        got.includes('NO_ACTION') && wanted.includes('BOOK')
          ? 'The agent reached a refusal on a request the clinic can satisfy — a guard fired (most often the caller ' +
            'not being identified to its satisfaction) and nothing after that could book.'
          : 'The conversation ended somewhere other than where the case leads, so the decider read this shape of call ' +
            'as a different kind of request.',
      evidence: near(result.call.transcript, null),
      suggestion:
        got.includes('NO_ACTION') && wanted.includes('BOOK')
          ? 'A refusal was recorded for a bookable request: check the guard that decided it, and whether the caller was identified.'
          : 'Check the decider prompt for which record this shape of call should produce.',
    });
  }

  for (const miss of result.grade.misses) {
    const field = /^(\w[\w.]*)\b/.exec(miss)?.[1];
    if (field === 'reason') {
      found.push({
        code: 'wrong_reason',
        severity: 'major',
        detail: miss,
        why: 'The agent worked out that it had to refuse but not which rule was refusing, so it reached for a nearby code.',
        suggestion: 'The refusal is right but the reason is not; reasons are scored, so map the blocking rule to its exact code.',
        evidence: near(result.call.transcript, null),
      });
    } else if (field === 'slot' || field === 'start_time') {
      found.push({
        code: 'wrong_slot',
        severity: 'major',
        detail: miss,
        why:
          'The time in the record came from the words in the conversation rather than from the slot the availability ' +
          'call returned, so rounding, a spoken "half past" or a timezone shifted it.',
        suggestion: 'Book the slot the availability call returned, not a time the agent restated in words.',
        evidence: near(result.call.transcript, (t) => /\d{1,2}[:.]\d{2}|o'clock|y media|en punto/i.test(t.text), 3),
      });
    } else if (field === 'provider_id' || field === 'location_id') {
      found.push({
        code: 'wrong_where',
        severity: 'major',
        detail: miss,
        why:
          'The provider or site was resolved a second time, by name, when the record was written — and the name ' +
          'matched a different row than the slot did.',
        suggestion: 'Carry the provider and site from the chosen slot into the record instead of re-resolving them by name.',
        evidence: near(result.call.transcript, null),
      });
    } else if (field === 'patient_id') {
      found.push({
        code: 'wrong_patient',
        severity: 'blocker',
        detail: miss,
        why:
          'The lookup settled on the first plausible match instead of the one the caller identified, which is what a ' +
          'namesake or a partial identifier does to a name search.',
        suggestion: 'The record names the wrong patient — check the namesake handling and the identifier used to look them up.',
        evidence: near(result.call.transcript, (t) => ASKS_ID.test(t.text), 4),
      });
    }
  }

  if (!result.pass && kase.problem_id !== 'the_new_patient' && !said.some((t) => ASKS_ID.test(t)) && kase.persona.data.national_id) {
    found.push({
      code: 'never_identified',
      severity: 'major',
      detail: 'The agent never asked for an identifier, so nothing it booked can be tied to the patient on file.',
      why:
        'The caller gave a name and the agent took it, so identification never became a step of the call — and by the ' +
        'time a decision was due there was no way to look the patient up.',
      suggestion: 'Ask for a DNI, phone number or date of birth before the call reaches a decision.',
      evidence: result.call.transcript.slice(0, 4).map(line),
    });
  }

  if (kase.language !== 'en' && said.length > 0) {
    const inLanguage = kase.language === 'ca' ? CATALAN : SPANISH;
    if (!said.some((t) => inLanguage.test(t))) {
      found.push({
        code: 'wrong_language',
        severity: 'major',
        detail: `The caller speaks ${kase.language} and the agent answered in something else.`,
        why:
          'The language was fixed before the caller spoke rather than taken from what they said, so the whole call ran ' +
          'in the default one.',
        suggestion: 'Follow the caller into their language on the first turn and stay there for the rest of the call.',
        evidence: result.call.transcript.slice(0, 4).map(line),
      });
    }
  }

  if (result.call.caller_turns.length >= kase.persona.turn_cap && !result.pass) {
    found.push({
      code: 'ran_long',
      severity: 'minor',
      detail: `The caller used all ${kase.persona.turn_cap} of their turns without getting there.`,
      why:
        'The turns went on confirming things already said instead of asking for the one fact still missing, so the call ' +
        'ran out of room before it reached a decision.',
      suggestion: 'Ask for the missing fact directly instead of confirming things the caller has already said.',
      evidence: near(result.call.transcript, null),
    });
  }

  return found;
}

/** One paragraph on a failure, from the model if there is one, from the misses if not. */
export async function summarise(kase: Case, result: CaseResult): Promise<string> {
  const transcript = result.call.transcript.map((t) => `${t.role === 'user' ? 'caller' : 'agent'}: ${t.text}`).join('\n');
  const fallback = result.grade.misses.join('; ') || 'No record was submitted.';
  if (!llmAvailable()) return fallback;
  try {
    return await chat(
      [
        {
          role: 'system',
          content:
            'You review a voice agent that books clinic appointments. Given one failed test call, say in two ' +
            'sentences what the agent actually got wrong and the smallest change that would fix it. No preamble, ' +
            'no restating the transcript, no bullet points.',
        },
        {
          role: 'user',
          content: [
            `Case: ${kase.title} (problem ${kase.problem})`,
            `What the case wants: ${JSON.stringify(kase.expected.acceptable[0]?.actions ?? [])}`,
            `What was submitted: ${JSON.stringify(result.actions)}`,
            `Misses: ${fallback}`,
            '',
            'Transcript:',
            transcript || '(nothing was transcribed)',
          ].join('\n'),
        },
      ],
      { maxTokens: 220 },
    );
  } catch {
    return fallback;
  }
}

export interface IssueDraft {
  problem_id: string;
  title: string;
  body: string;
  labels: string[];
  failing: string[];
}

/** The last thing each side said, which is usually where the call went wrong. */
function tail(result: CaseResult, turns = 6): string[] {
  return result.call.transcript.slice(-turns).map((t) => `${t.role === 'user' ? 'caller' : 'agent'}: ${t.text}`);
}

/** One failing call written out in full: who rang, what was wanted, what arrived. */
function caseSection(f: CaseResult, kase: Case | undefined): string[] {
  const wanted = kase?.expected.acceptable[0]?.actions ?? [];
  const lines = [
    `#### \`${f.case_id}\` — ${f.title}`,
    '',
    `- caller: ${f.behaviour.replace(/\+/g, ' + ')}, talking ${f.vocabulary.replace(/\+/g, ' + ')} (${f.call.caller})`,
    `- the ask: ${kase?.summary ?? '(the suite has been regenerated since this run)'}`,
    `- line: ${(f.call.call_ms / 1000).toFixed(0)}s, ` +
      `${f.call.ms_to_first_audio === null ? 'no agent audio' : `${f.call.ms_to_first_audio}ms to first audio`}, ` +
      `${f.call.caller_turns.length} caller turns`,
    `- wanted: \`${JSON.stringify(wanted)}\``,
    `- submitted: \`${JSON.stringify(f.actions)}\``,
  ];
  if (f.grade.misses.length > 0) lines.push(`- missed: ${f.grade.misses.join('; ')}`);
  if (f.leaked.length > 0) lines.push(`- said out loud what it must not: ${f.leaked.join(', ')}`);
  if (f.summary) lines.push('', f.summary);
  for (const i of f.insights) {
    lines.push('', `**${i.code}** — ${i.detail} *Why:* ${i.why}`);
    if (i.evidence.length > 0) lines.push('', 'Where it shows:', '```', ...i.evidence, '```');
  }
  const said = tail(f);
  if (said.length > 0) lines.push('', 'The end of the call:', '```', ...said, '```');
  return [...lines, ''];
}

/** One issue per problem that is failing, with the calls that prove it. */
export function issueDrafts(results: CaseResult[], byId?: Map<string, Case>): IssueDraft[] {
  const byProblem = new Map<string, CaseResult[]>();
  for (const r of results) {
    if (r.pass) continue;
    byProblem.set(r.problem_id, [...(byProblem.get(r.problem_id) ?? []), r]);
  }

  return [...byProblem.entries()].map(([problemId, failures]) => {
    const all = results.filter((r) => r.problem_id === problemId);
    // One entry per kind of failure, kept from the call that shows it most plainly:
    // the one that actually left a transcript to quote.
    const codes = new Map<string, Insight>();
    for (const f of failures) {
      for (const i of f.insights) {
        const held = codes.get(i.code);
        if (!held || (held.evidence.length === 0 && i.evidence.length > 0)) codes.set(i.code, i);
      }
    }
    const worst: Severity = [...codes.values()].some((i) => i.severity === 'blocker')
      ? 'blocker'
      : [...codes.values()].some((i) => i.severity === 'major')
        ? 'major'
        : 'minor';

    const body = [
      `${failures.length} of ${all.length} local cases fail on **${failures[0]!.problem_id}**.`,
      '',
      '### What goes wrong, and why',
      '',
      ...[...codes.values()].flatMap((i) => [
        `**${i.code}** (${i.severity}) — ${i.detail}`,
        '',
        `*Why:* ${i.why}`,
        ...(i.evidence.length > 0
          ? ['', 'Heard on the line:', '```', ...i.evidence, '```']
          : []),
        '',
      ]),
      '### Suggested fix',
      ...[...new Set([...codes.values()].map((i) => i.suggestion))].map((s) => `- ${s}`),
      '',
      '### Failing cases',
      '',
      ...failures.flatMap((f) => caseSection(f, byId?.get(f.case_id))),
      '',
      '_Generated by the dashboard test lab._',
    ].join('\n');

    return {
      problem_id: problemId,
      title: `${failures[0]!.problem_id}: ${failures.length}/${all.length} local cases failing`,
      body,
      labels: ['agent-quality', `problem:${problemId}`, worst],
      failing: failures.map((f) => f.case_id),
    };
  });
}
