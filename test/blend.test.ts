/**
 * Picking two difficult traits asks for one difficult person, not two calls.
 *
 * The blend is what the test lab dials with, so what matters is that nothing is
 * dropped on the way: both sets of instructions go to the caller agent, and the
 * mechanical parts take the harder of each — the longer silence, the noisier
 * room, barge-in if either one bargs in.
 */

import { blendBehaviours } from '../testlab/behaviour.js';
import { interleave } from '../testlab/runner.js';
import { blendVocabularies } from '../testlab/vocabulary.js';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
}

const talksOver = blendBehaviours(['talks_over']);
const wontListen = blendBehaviours(['wont_listen']);
const both = blendBehaviours(['talks_over', 'wont_listen']);

check('one trait is itself', both.id !== talksOver.id && talksOver.id === 'talks_over');
check('two traits are one caller', both.id === 'talks_over+wont_listen', both.id);
check(
  'and that caller carries both sets of instructions',
  both.instructions.includes(talksOver.instructions) && both.instructions.includes(wontListen.instructions),
  both.instructions,
);
check('barge-in survives the blend', both.barge_in === (talksOver.barge_in || wontListen.barge_in));
check(
  'the longer silence wins',
  both.lead_ms === Math.max(talksOver.lead_ms, wontListen.lead_ms) &&
    both.tail_ms === Math.max(talksOver.tail_ms, wontListen.tail_ms),
);

const noisy = blendBehaviours(['grey_noise', 'mumbler']);
const grey = blendBehaviours(['grey_noise']);
check('the noisiest room wins', noisy.audio?.background === grey.audio?.background, String(noisy.audio?.background));

check('nothing picked is a cooperative caller', blendBehaviours([]).id === 'cooperative');
check('cooperative plus a trait is the trait', blendBehaviours(['cooperative', 'angry']).id === 'angry');
check('the same trait twice is once', blendBehaviours(['angry', 'angry']).id === 'angry');

const vague = blendVocabularies(['vague']);
const mixed = blendVocabularies(['vague', 'code_switching']);
check('two ways of talking are one way of talking', mixed.id === 'vague+code_switching', mixed.id);
check('and it keeps both', mixed.instructions.includes(vague.instructions), mixed.instructions);
check('plain plus one is that one', blendVocabularies(['plain', 'terse']).id === 'terse');

// And the order a round is dialled in: round-robin over the problems, so a round read
// or stopped early has something to say about the whole board.
const job = (id: string, problemId: string, copy = 0) => ({ kase: { id, problem_id: problemId }, copy });

const turns = interleave([job('a-1', 'a'), job('a-2', 'a'), job('b-1', 'b'), job('b-2', 'b'), job('c-1', 'c')]);
check(
  'a round takes one case from each problem in turn',
  turns.map((j) => j.kase.id).join(',') === 'a-1,b-1,c-1,a-2,b-2',
  turns.map((j) => j.kase.id).join(','),
);

const burst = interleave([
  job('a-1', 'a'),
  job('sw', 'switchboard', 0),
  job('sw', 'switchboard', 1),
  job('sw', 'switchboard', 2),
  job('a-2', 'a'),
]);
check(
  'but a burst still rings all at once',
  burst.map((j) => `${j.kase.id}#${j.copy}`).join(',') === 'a-1#0,sw#0,sw#1,sw#2,a-2#0',
  burst.map((j) => `${j.kase.id}#${j.copy}`).join(','),
);

const many = ['a', 'b', 'c'].flatMap((p) => [1, 2, 3, 4].map((n) => job(`${p}-${n}`, p)));
const dialled = interleave(many);
check(
  'nothing is dropped or dialled twice',
  dialled.length === many.length && new Set(dialled.map((j) => j.kase.id)).size === many.length,
  `${dialled.length} of ${many.length}`,
);

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
