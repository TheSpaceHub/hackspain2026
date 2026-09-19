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
  detail: string;
  suggestion: string;
}

export interface CaseResult {
  case_id: string;
  problem_id: string;
  title: string;
  behaviour: string;
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
      suggestion: 'Check the TTS path and the greeting: first audio must leave inside a second of the socket opening.',
    });
  } else if ((result.call.ms_to_first_audio ?? 0) > 2_000) {
    found.push({
      code: 'slow_greeting',
      severity: 'minor',
      detail: `First audio took ${result.call.ms_to_first_audio}ms.`,
      suggestion: 'Send the greeting from a cached utterance rather than waiting on the first model turn.',
    });
  }

  if (heard.length === 0 && result.call.caller_turns.length > 0) {
    found.push({
      code: 'deaf',
      severity: 'blocker',
      detail: 'Nothing the caller said was transcribed — the agent heard none of the call.',
      suggestion: 'Check STT: language hints, the endpointing model, and whether the noise bed is drowning the caller.',
    });
  }

  if (result.leaked.length > 0) {
    found.push({
      code: 'privacy_leak',
      severity: 'blocker',
      detail: `Said something it was told to protect: ${result.leaked.join(', ')}.`,
      suggestion: 'Never read an identifier, phone number or diary entry back to a caller who has not been identified as the patient.',
    });
  }

  if (result.actions.length === 0) {
    found.push({
      code: 'no_record',
      severity: 'blocker',
      detail: 'Nothing was submitted before the window shut.',
      suggestion: 'The decider must always write a record: a refusal with a reason still scores, silence never does.',
    });
  } else if (wanted.length > 0 && got.join('+') !== wanted.join('+')) {
    found.push({
      code: 'wrong_action',
      severity: 'major',
      detail: `Submitted ${got.join(' + ')} where the case wants ${wanted.join(' + ')}.`,
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
        suggestion: 'The refusal is right but the reason is not; reasons are scored, so map the blocking rule to its exact code.',
      });
    } else if (field === 'slot' || field === 'start_time') {
      found.push({
        code: 'wrong_slot',
        severity: 'major',
        detail: miss,
        suggestion: 'Book the slot the availability call returned, not a time the agent restated in words.',
      });
    } else if (field === 'provider_id' || field === 'location_id') {
      found.push({
        code: 'wrong_where',
        severity: 'major',
        detail: miss,
        suggestion: 'Carry the provider and site from the chosen slot into the record instead of re-resolving them by name.',
      });
    } else if (field === 'patient_id') {
      found.push({
        code: 'wrong_patient',
        severity: 'blocker',
        detail: miss,
        suggestion: 'The record names the wrong patient — check the namesake handling and the identifier used to look them up.',
      });
    }
  }

  if (!result.pass && kase.problem_id !== 'the_new_patient' && !said.some((t) => ASKS_ID.test(t)) && kase.persona.data.national_id) {
    found.push({
      code: 'never_identified',
      severity: 'major',
      detail: 'The agent never asked for an identifier, so nothing it booked can be tied to the patient on file.',
      suggestion: 'Ask for a DNI, phone number or date of birth before the call reaches a decision.',
    });
  }

  if (kase.language !== 'en' && said.length > 0) {
    const inLanguage = kase.language === 'ca' ? CATALAN : SPANISH;
    if (!said.some((t) => inLanguage.test(t))) {
      found.push({
        code: 'wrong_language',
        severity: 'major',
        detail: `The caller speaks ${kase.language} and the agent answered in something else.`,
        suggestion: 'Follow the caller into their language on the first turn and stay there for the rest of the call.',
      });
    }
  }

  if (result.call.caller_turns.length >= kase.persona.turn_cap && !result.pass) {
    found.push({
      code: 'ran_long',
      severity: 'minor',
      detail: `The caller used all ${kase.persona.turn_cap} of their turns without getting there.`,
      suggestion: 'Ask for the missing fact directly instead of confirming things the caller has already said.',
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

/** One issue per problem that is failing, with the calls that prove it. */
export function issueDrafts(results: CaseResult[]): IssueDraft[] {
  const byProblem = new Map<string, CaseResult[]>();
  for (const r of results) {
    if (r.pass) continue;
    byProblem.set(r.problem_id, [...(byProblem.get(r.problem_id) ?? []), r]);
  }

  return [...byProblem.entries()].map(([problemId, failures]) => {
    const all = results.filter((r) => r.problem_id === problemId);
    const codes = new Map<string, Insight>();
    for (const f of failures) for (const i of f.insights) codes.set(i.code, i);
    const worst: Severity = [...codes.values()].some((i) => i.severity === 'blocker')
      ? 'blocker'
      : [...codes.values()].some((i) => i.severity === 'major')
        ? 'major'
        : 'minor';

    const body = [
      `${failures.length} of ${all.length} local cases fail on **${failures[0]!.problem_id}**.`,
      '',
      '### What goes wrong',
      ...[...codes.values()].map((i) => `- **${i.code}** — ${i.detail}`),
      '',
      '### Suggested fix',
      ...[...new Set([...codes.values()].map((i) => i.suggestion))].map((s) => `- ${s}`),
      '',
      '### Failing cases',
      ...failures.map((f) => {
        const lines = [`- \`${f.case_id}\` — ${f.title}`];
        if (f.summary) lines.push(`  - ${f.summary}`);
        for (const miss of f.grade.misses.slice(0, 4)) lines.push(`  - miss: ${miss}`);
        return lines.join('\n');
      }),
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
