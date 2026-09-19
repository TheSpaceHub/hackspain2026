/**
 * From a failing problem to the change that would fix it.
 *
 * The issue draft says what the agent got wrong; this asks a model to say where
 * in this repository it is wrong and what to write instead, given the header
 * comment of every source file as a map of the place. The output is a plan a
 * person — or a coding agent — can act on: files, the change to each, and the
 * branch, commit and pull request to carry it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IssueDraft } from './insights.js';
import { chat, llmAvailable } from './llm.js';

export interface FixPlan {
  problem_id: string;
  branch: string;
  plan: string;
}

/** Every source file, with the doc comment it opens with: a map, not the territory. */
function sourceMap(root: string): string {
  const dirs = ['src', 'src/store'];
  const out: string[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts'));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(dir, file);
      const text = readFileSync(join(root, path), 'utf8');
      const header = /^\/\*\*([\s\S]*?)\*\//.exec(text)?.[1] ?? '';
      const gist = header
        .split('\n')
        .map((l) => l.replace(/^\s*\*\s?/, '').trim())
        .filter((l) => l !== '')
        .join(' ')
        .slice(0, 220);
      out.push(`- ${path} (${text.split('\n').length} lines)${gist ? `: ${gist}` : ''}`);
    }
  }
  return out.join('\n');
}

export function fixBranch(problemId: string): string {
  return `fix/${problemId.replace(/_/g, '-')}`;
}

export async function fixPlan(issue: IssueDraft, root: string): Promise<FixPlan> {
  if (!llmAvailable()) {
    throw new Error('no model configured — set ANTHROPIC_API_KEY or the Cloudflare pair to draft a fix');
  }
  const plan = await chat(
    [
      {
        role: 'system',
        content: [
          'You are a senior engineer on a voice agent that books clinic appointments over the telephone.',
          'You are given a test report and a map of the repository. Say where the fault most likely is and',
          'what to change, concretely: name the files, the functions, and the shape of the new code or prompt',
          'text. No preamble, no restating the report. Use these headings exactly:',
          '## Where it is', '## The change', '## How to check it', '## Pull request',
          'Under "Pull request" give a title and a two-sentence body. If the report does not narrow the fault',
          'to one place, say what to instrument first instead of guessing.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          '# Test report', '', `${issue.title}`, '', issue.body.slice(0, 6_000), '',
          '# The repository', '',
          'The agent runs as a Node service: audio in over a Twilio-shaped websocket, a decider that chooses',
          'the record to submit, and a client for the clinic API.', '',
          sourceMap(root),
        ].join('\n'),
      },
    ],
    { maxTokens: 900, timeoutMs: 60_000 },
  );
  return { problem_id: issue.problem_id, branch: fixBranch(issue.problem_id), plan };
}
