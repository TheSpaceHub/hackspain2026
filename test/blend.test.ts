/**
 * Picking two difficult traits asks for one difficult person, not two calls.
 *
 * The blend is what the test lab dials with, so what matters is that nothing is
 * dropped on the way: both sets of instructions go to the caller agent, and the
 * mechanical parts take the harder of each — the longer silence, the noisier
 * room, barge-in if either one bargs in.
 */

import { blendBehaviours } from '../testlab/behaviour.js';
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

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
