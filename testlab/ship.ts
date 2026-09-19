/**
 * From the fix plan to a pull request, written by Devin.
 *
 * Nearly every failure the lab finds is one of two small things: a guardrail
 * that should have refused deterministically, or a line of the prompt the
 * decider is built from. Both are a few lines of code away, so the button that
 * reads a run's issue hands the report, the plan and the failing transcripts to
 * a Devin session over the API and lets it write the branch and open the PR.
 *
 * Nothing is written here: this process only starts the session and remembers
 * where it is, so the tab can link to it while it works.
 */
import { execFileSync } from 'node:child_process';
import type { IssueDraft } from './insights.js';
import { fixBranch, type FixPlan } from './fix.js';

const API = process.env.DEVIN_API_BASE_URL ?? 'https://api.devin.ai';

export interface Shipment {
  problem_id: string;
  session_id: string;
  /** The session in the Devin app: what the tab links to. */
  url: string;
  branch: string;
  repo: string;
  started_at: string;
}

export function shippingAvailable(): boolean {
  return (process.env.DEVIN_API_KEY ?? '') !== '';
}

/**
 * The repository the PR should land in: told to us, or read off the checkout's
 * own origin, so a fork gets its own PRs rather than someone else's.
 */
export function targetRepo(root: string): string | null {
  if (process.env.TESTLAB_FIX_REPO) return process.env.TESTLAB_FIX_REPO;
  try {
    const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = /(?:github\.com[/:])([^/]+\/[^/\s]+?)(?:\.git)?$/.exec(url);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** What the session is told: the failure, where it probably is, and how to know it is fixed. */
export function shipPrompt(issue: IssueDraft, plan: FixPlan | null, repo: string, branch: string): string {
  return [
    `Fix a fault in the voice agent in ${repo}, found by its own test lab, and open a pull request for it.`,
    '',
    'Almost every fault this lab finds is one of two things. Either a guardrail that should have refused or',
    'corrected deterministically in code (src/guards.ts, src/schema.ts, src/agent-tools.ts), or a detail of the',
    'prompt the decider and the agent are built from (src/decider.ts, src/agent.ts, src/patient-brief.ts).',
    'Prefer the deterministic one: if the behaviour can be enforced in code rather than asked for in a prompt,',
    'enforce it in code. Keep the change small and in the agent, not in the test lab — do not edit the cases,',
    'the grading or the expectations to make the report go away.',
    '',
    `Work on a branch named ${branch}, off the default branch. Before opening the PR run 'pnpm typecheck' and`,
    "'pnpm test' and make them pass. In the pull request body, quote the transcript line below that shows the",
    'fault, say what the agent did, and say why the change stops it.',
    '',
    '# The report',
    '',
    `## ${issue.title}`,
    '',
    issue.body.slice(0, 12_000),
    ...(plan === null ? [] : ['', '# A first reading of where it is', '', plan.plan.slice(0, 6_000)]),
  ].join('\n');
}

export async function shipFix(
  issue: IssueDraft,
  plan: FixPlan | null,
  repo: string,
  timeoutMs = 30_000,
): Promise<Shipment> {
  const key = process.env.DEVIN_API_KEY ?? '';
  if (key === '') throw new Error('no DEVIN_API_KEY — set one to have Devin write the fix');

  const branch = fixBranch(issue.problem_id);
  const res = await fetch(`${API}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: shipPrompt(issue, plan, repo, branch),
      title: `Fix ${issue.problem_id}: ${issue.title}`.slice(0, 120),
      tags: ['testlab', issue.problem_id],
      idempotent: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Devin API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { session_id?: string; url?: string };
  if (!body.session_id || !body.url) throw new Error('Devin API returned no session');
  return {
    problem_id: issue.problem_id,
    session_id: body.session_id,
    url: body.url,
    branch,
    repo,
    started_at: new Date().toISOString(),
  };
}
