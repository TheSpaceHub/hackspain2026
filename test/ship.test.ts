/**
 * What Devin is told when a fix is handed over.
 *
 * The session is started from the tab and then runs unattended, so the prompt is
 * the whole brief: the report with its transcript lines, the branch, where the
 * fault classes live, and the instruction not to make the test agree with the
 * agent instead of the other way round.
 */

import { shipPrompt, targetRepo } from '../testlab/ship.js';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
}

const issue = {
  problem_id: 'the_rules',
  title: 'Books a patient the clinic will not see',
  body: '## What goes wrong\n\n> caller: I am seventeen\n\nThe agent booked an adult-only provider.',
  labels: ['agent'],
  failing: ['rules-1'],
};

const prompt = shipPrompt(issue, null, 'owner/repo', 'fix/the-rules');

check('it names the repository and the branch', prompt.includes('owner/repo') && prompt.includes('fix/the-rules'));
check('it carries the report, transcript line and all', prompt.includes('I am seventeen') && prompt.includes(issue.title));
check('it says where the two kinds of fault live', prompt.includes('src/guards.ts') && prompt.includes('src/decider.ts'));
check('it asks for the deterministic fix first', /enforce it in code/.test(prompt));
check('it forbids fixing the test instead of the agent', /do not edit the cases/i.test(prompt));
check('it asks for typecheck and tests before the PR', prompt.includes('pnpm typecheck') && prompt.includes('pnpm test'));

const withPlan = shipPrompt(issue, { problem_id: 'the_rules', branch: '', plan: 'Change canBook()' }, 'o/r', 'b');
check('a drafted plan rides along when there is one', withPlan.includes('Change canBook()'));

const told = process.env.TESTLAB_FIX_REPO;
process.env.TESTLAB_FIX_REPO = 'someone/elses-fork';
check('an explicit target wins', targetRepo(process.cwd()) === 'someone/elses-fork');
delete process.env.TESTLAB_FIX_REPO;
const found = targetRepo(process.cwd());
check('otherwise it reads the checkout owner/name off origin', found === null || /^[^/]+\/[^/]+$/.test(found), String(found));
if (told !== undefined) process.env.TESTLAB_FIX_REPO = told;

console.log(failed === 0 ? '\nship: all passed' : `\nship: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
