/**
 * How they talk, as opposed to what they are like to deal with.
 *
 * A behaviour decides whether the caller listens; a vocabulary decides what their
 * sentences are made of — none of it put on for the occasion — and so whether
 * "the knee thing, the usual place, soon" ever becomes a specialty, a site and a
 * date. The two multiply: a vague caller who also will not listen is a different
 * call from either on its own.
 */
export interface Vocabulary {
  id: string;
  label: string;
  description: string;
  /** Added to the persona's own instructions; empty for the plain speaker. */
  instructions: string;
}

export const VOCABULARIES: Vocabulary[] = [
  {
    id: 'plain',
    label: 'Plain',
    description: 'Says what they mean, in one language. The control.',
    instructions: '',
  },
  {
    id: 'vague',
    label: 'Vague',
    description: 'Says it sideways: "I have been feeling rough", "after work" — plain enough once asked.',
    instructions: [
      'You put things indirectly, the way people do: you say what is going on rather than what you want —',
      '"I have not been feeling right since the weekend" instead of "I would like to see the doctor" — and you',
      'give times as parts of the day, "after work", "first thing", "once the kids are at school", rather than',
      'a clock time. It is not evasion and you are not being difficult: ask you a direct question and you',
      'answer it plainly, offer you an exact time and you say yes or no to it. You simply would not have put it',
      'that precisely yourself.',
    ].join(' '),
  },
  {
    id: 'code_switching',
    label: 'Switches language',
    description: 'Starts in one language and drifts into another mid-sentence.',
    instructions: [
      'You switch language mid-sentence without noticing — a clause in Spanish, the next in Catalan or English,',
      'numbers and dates often in a different language from the rest of the sentence. If they answer in one',
      'language you may carry on in another.',
    ].join(' '),
  },
  {
    id: 'off_topic',
    label: 'Off topic',
    description: 'Drifts off the point — into the parking, the last visit, the wait — then comes back.',
    instructions: [
      'You drift off the point, but only ever around your own visit: the parking at the clinic, how long the',
      'wait was last time, the tablets you were given, getting there after work. One short drift per turn at',
      'most, then you are back on the phone call. You never bring up the world outside your own health and',
      'appointments, and you never ask them about themselves.',
    ].join(' '),
  },
  {
    id: 'jargon',
    label: 'Over-specific',
    description: 'Medical jargon and self-diagnosis instead of a plain request.',
    instructions: [
      'You have read a great deal about your condition and you talk in its language: syndromes, procedures,',
      'doses. You are confident you know what it is, so you ask for the test you have decided on rather than',
      'describing what is actually wrong.',
    ].join(' '),
  },
  {
    id: 'terse',
    label: 'One-word answers',
    description: 'Says as little as a sentence can carry.',
    instructions: [
      'You are not one for talking on the phone. "Yes." "Monday." "No." You answer what you were asked and',
      'nothing more — not to be difficult, it just does not occur to you to add anything.',
    ].join(' '),
  },
];

export const VOCAB_BY_ID = new Map(VOCABULARIES.map((v) => [v.id, v]));

export function vocabularyOf(id: string | undefined): Vocabulary {
  return VOCAB_BY_ID.get(id ?? 'plain') ?? VOCAB_BY_ID.get('plain')!;
}

/** One way of talking made of several: vague *and* code-switching, in the same sentence. */
export function blendVocabularies(ids: readonly string[]): Vocabulary {
  const chosen = [...new Set(ids)].map(vocabularyOf).filter((v) => v.id !== 'plain');
  if (chosen.length === 0) return vocabularyOf('plain');
  if (chosen.length === 1) return chosen[0]!;
  return {
    id: chosen.map((v) => v.id).join('+'),
    label: chosen.map((v) => v.label).join(' + '),
    description: `All at once: ${chosen.map((v) => v.description.replace(/\.$/, '')).join('; ')}.`,
    instructions: [
      'You talk in all of these ways at once, in the same sentences:',
      ...chosen.map((v) => `- ${v.label}: ${v.instructions}`),
    ].join('\n'),
  };
}
