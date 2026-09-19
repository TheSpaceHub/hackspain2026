/**
 * How they talk, as opposed to what they are like to deal with.
 *
 * A behaviour decides whether the caller listens; a vocabulary decides what their
 * sentences are made of — whether "the knee thing, the usual place, soon" ever
 * becomes a specialty, a site and a date. The two multiply: a vague caller who
 * also will not listen is a different call from either on its own.
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
    description: 'Never names the specialty, the doctor or the day outright.',
    instructions: [
      'You speak in vague terms and you avoid naming things. It is "the bone people", "the usual place",',
      '"my regular one", "soon-ish, after work". When pressed for a specific you give another approximation',
      'first, and only name the actual thing if they ask you twice.',
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
    description: 'Talks about everything except the thing they rang about.',
    instructions: [
      'You keep wandering off the subject — the weather, the parking, a programme you watched, what the last',
      'doctor said about your neighbour. You get back to the point only when they pull you back, and not for long.',
    ].join(' '),
  },
  {
    id: 'jargon',
    label: 'Over-specific',
    description: 'Medical jargon and self-diagnosis instead of a plain request.',
    instructions: [
      'You have read about your condition and you talk in its language: you name syndromes, procedures and',
      'medication doses, you self-diagnose confidently, and you ask for the test you have decided you need',
      'rather than describing what is wrong.',
    ].join(' '),
  },
  {
    id: 'terse',
    label: 'One-word answers',
    description: 'Says as little as a sentence can carry.',
    instructions: [
      'You answer in one or two words. "Yes." "Monday." "No." You volunteer nothing, you never explain, and',
      'you make them ask for every single field separately.',
    ].join(' '),
  },
];

export const VOCAB_BY_ID = new Map(VOCABULARIES.map((v) => [v.id, v]));

export function vocabularyOf(id: string | undefined): Vocabulary {
  return VOCAB_BY_ID.get(id ?? 'plain') ?? VOCAB_BY_ID.get('plain')!;
}
