/**
 * The reflector: a stronger, slower model reads the failing traces of one prompt and
 * proposes a revised prompt. It is asked for a diagnosis first and the smallest edit
 * that addresses it second, and the result is checked before it becomes a candidate:
 * the safety sections are frozen byte-for-byte and the prompt may not grow without bound.
 */
import type { Trace } from './rollout.js';
import { complete } from './workers-ai.js';

export const FROZEN_HEADINGS = ['# If it is urgent', '# Boundaries'];

/** Heading to just before the next `# ` heading (or end of text). */
export function section(prompt: string, heading: string): string | undefined {
  const start = prompt.indexOf(heading);
  if (start === -1) return undefined;
  const next = prompt.indexOf('\n# ', start + heading.length);
  return prompt.slice(start, next === -1 ? prompt.length : next).trimEnd();
}

export function frozenSections(baseline: string): string[] {
  return FROZEN_HEADINGS.map((h) => {
    const s = section(baseline, h);
    if (!s) throw new Error(`baseline prompt has no section ${h}`);
    return s;
  });
}

export interface Invariants {
  frozen: string[];
  maxWords: number;
}

export function violations(prompt: string, inv: Invariants): string[] {
  const out: string[] = [];
  for (const s of inv.frozen) {
    if (!prompt.includes(s)) out.push(`frozen section altered or missing: ${s.split('\n')[0]}`);
  }
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (words > inv.maxWords) out.push(`prompt is ${words} words, cap ${inv.maxWords}`);
  if (!/You are Ana/.test(prompt)) out.push('identity line missing');
  for (const must of ['find_slots', 'accept_slot', 'identify_patient']) {
    if (!prompt.includes(must)) out.push(`tool ${must} no longer mentioned`);
  }
  return out;
}

function compactTrace(t: Trace): string {
  const lines: string[] = [];
  lines.push(`## case ${t.case} (${t.family}) — ${t.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`expected record: ${JSON.stringify(t.expect)}`);
  lines.push(`submitted record: ${JSON.stringify(t.submitted)}`);
  if (t.misses.length) lines.push(`grader: ${t.misses.join(' | ')}`);
  lines.push('transcript:');
  const byTurn = new Map<number, string[]>();
  for (const tool of t.tools) {
    const list = byTurn.get(tool.turn) ?? [];
    list.push(`  [tool ${tool.name}${tool.printed ? ' (PRINTED AS TEXT)' : ''} ${tool.args} -> ${tool.result.slice(0, 220)}]`);
    byTurn.set(tool.turn, list);
  }
  let turn = 0;
  for (const line of t.transcript) {
    if (line.role === 'user') {
      turn++;
      lines.push(`  Caller: ${line.text}`);
      for (const tl of byTurn.get(turn) ?? []) lines.push(tl);
    } else {
      lines.push(`  Ana: ${line.text}`);
    }
  }
  lines.push(`notes the extractor kept:\n  ${t.callState.replace(/\n/g, '\n  ')}`);
  lines.push(`decider: ${JSON.stringify(t.decider.actions)}${t.decider.notes ? ` — ${t.decider.notes}` : ''}`);
  if (t.errors.length) lines.push(`pipeline notes: ${t.errors.join(' | ')}`);
  if (!t.hungUp) lines.push('the caller never hung up: the call ran out of turns');
  return lines.join('\n');
}

const REFLECT_SYSTEM = `You are improving the system prompt of a telephone receptionist agent ("Ana") for a clinic. The agent runs on a small, fast model (Llama 3.3 70B) with tools; after the call, a separate decider reads the transcript and the notes and writes the record that is graded. The grade is binary and exact: the record must match the expected action and fields.

You will be shown the current prompt and the traces of calls that failed (and a few that passed, for contrast). Your job:
1. Diagnose. For each failure, name the earliest point where the agent's *behaviour* (not the caller's) made the wrong record likely, and say which rule in the prompt was missing, unclear, contradicted by another rule, or ignored. Distinguish agent-prompt failures from failures that happen after the call (decider, extractor) — you can only change the agent prompt, but the agent's words are what the decider reads, so sometimes the fix is to make the agent say or confirm something out loud. If a failure is only a differing \`reason\` on an otherwise correct no_action/escalate record and the agent's own words were fine, say so and leave it alone: spend the edit on a case where the agent's behaviour was actually wrong.
2. Edit. Propose the SMALLEST change to the prompt that addresses the diagnosis: reword one rule, add one sentence, remove one contradictory sentence, or move one sentence. Do not rewrite sections that are not implicated. Do not add generic advice. Prefer deleting or tightening over adding. Every sentence costs latency on a live call.

Hard constraints on the edited prompt:
- The sections "# If it is urgent" and "# Boundaries" must be reproduced byte-for-byte; do not touch them.
- Keep the tool names exactly as they are.
- Keep the prompt shorter than it is now, or at most about five percent longer.
- No markdown lists, bullets, or emoji in the prompt body beyond the existing "# " headings — the model reads it as prose.

Answer in exactly this shape:

DIAGNOSIS:
<a few sentences>

EDIT:
<one or two sentences describing the change>

PROMPT:
<the full revised prompt, verbatim, nothing after it>`;

export interface Reflection {
  diagnosis: string;
  edit: string;
  prompt: string;
  raw: string;
}

export async function reflect(
  prompt: string,
  failures: Trace[],
  passes: Trace[],
  model: string,
): Promise<Reflection> {
  const user = [
    '# Current prompt',
    prompt,
    '',
    '# Failed calls',
    ...failures.map(compactTrace),
    ...(passes.length ? ['', '# Passed calls, for contrast', ...passes.map(compactTrace)] : []),
  ].join('\n\n');
  const raw = await complete(
    [
      { role: 'system', content: REFLECT_SYSTEM },
      { role: 'user', content: user },
    ],
    { model, temperature: 0.4, maxTokens: 6_000, timeoutMs: 240_000 },
  );
  const m = /DIAGNOSIS:\s*([\s\S]*?)\n\s*EDIT:\s*([\s\S]*?)\n\s*PROMPT:\s*\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`reflector answer did not follow the shape: ${raw.slice(0, 300)}`);
  let revised = m[3]!.trim();
  revised = revised.replace(/^```[a-z]*\n/, '').replace(/\n```\s*$/, '').trim();
  return { diagnosis: m[1]!.trim(), edit: m[2]!.trim(), prompt: revised, raw };
}
