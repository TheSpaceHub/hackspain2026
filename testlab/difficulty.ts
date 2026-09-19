/**
 * How hard the call is, on top of who is making it.
 *
 * A behaviour says what sort of person rang; a difficulty says how much work
 * they are, and it is the same person either way — the easy one says the date
 * back to you and takes yes for an answer, the brutal one says "the usual place,
 * after work", volunteers nothing, and wants it read back twice before they will
 * agree to it. It scales rather than adds: no new trait, just more of what the
 * caller already is, so the same case can be run at four heights and the point
 * at which the agent stops coping is the score.
 */
import type { AudioBed } from '../mock/world/suite/types.js';
import type { Accent } from './audio.js';
import type { Behaviour } from './behaviour.js';

export interface Difficulty {
  id: string;
  label: string;
  description: string;
  /** Added to the caller's own instructions; empty at the level everything is written for. */
  instructions: string;
  /** Multiplies the caller's pace and their dead air, for a call that drags. */
  wpm_scale: number;
  lead_scale: number;
  /** A floor under that gap: a hard caller thinks before answering even if their trait does not. */
  lead_min_ms: number;
  /** Turns granted on top of the case's own cap: a hard call is a longer one. */
  extra_turns: number;
  /**
   * The line the call comes in on. Null leaves the case and the traits to decide;
   * `silence` at Easy means a clean line whatever they asked for.
   */
  audio: AudioBed | null;
  /** The agent's own accent, or one from further off, which the recogniser likes less. */
  accent: Accent;
  /** Quieter than the recogniser would like: 1 is an ordinary voice. */
  gain: number;
}

export const DIFFICULTIES: Difficulty[] = [
  {
    id: 'easy',
    label: 'Easy',
    description: 'Plain words, confirms first time, clean line, the accent the agent knows.',
    instructions: [
      'This is a good day and an easy call for you. You say what you want in plain words, you give a date and a',
      'time as a date and a time, your details are in front of you, and when they read something back you say',
      'yes or no straight away. You offer the next thing they will obviously need before they have to ask.',
    ].join(' '),
    wpm_scale: 1,
    lead_scale: 0.6,
    lead_min_ms: 0,
    extra_turns: 0,
    // A studio line: whatever room the case wanted, Easy takes it away.
    audio: { background: 'silence', signal_to_noise_db: null },
    accent: 'local',
    gain: 1,
  },
  {
    id: 'normal',
    label: 'Normal',
    description: 'An ordinary call: answers what is asked, confirms once, whatever line the case has.',
    instructions: '',
    wpm_scale: 1,
    lead_scale: 1,
    lead_min_ms: 0,
    extra_turns: 0,
    audio: null,
    accent: 'local',
    gain: 1,
  },
  {
    id: 'hard',
    label: 'Hard',
    description: 'Roundabout, confirms only on a read-back, a room behind them and a far accent.',
    instructions: [
      'This call is hard work, not because you mean it to be. You put things roundaboutly the first time —',
      'the day as "end of next week", the place as "the usual one" — and it takes a direct question to get the',
      'plain version out of you. You answer what you were asked and nothing beyond it, so anything they have',
      'not thought to ask for stays unsaid. You do not agree to an appointment until they have said the day,',
      'the time and who it is with back to you, and if a detail of that is wrong you say so and it starts again.',
    ].join(' '),
    wpm_scale: 0.92,
    lead_scale: 1.5,
    lead_min_ms: 900,
    extra_turns: 4,
    // A room behind them and an accent the recogniser was not tuned on.
    audio: { background: 'room', signal_to_noise_db: 16 },
    accent: 'far',
    gain: 0.85,
  },
  {
    id: 'brutal',
    label: 'Brutal',
    description: 'Vague throughout, changes their mind, and ringing from the street on a bad handset.',
    instructions: [
      'Everything about this call is against them, though none of it is meant unkindly. You describe rather than',
      'name — the specialty, the site, the doctor, the day all come out sideways, and even asked directly you',
      'reach for another rough description before the plain word comes. You volunteer nothing at all. Once in',
      'the call you change your mind about the day or the time, late, after they thought it was settled. You',
      'need the whole appointment read back to you twice before you will say yes, and a number you give is worth',
      'checking: you say one digit of it wrong the first time and correct it when they repeat it to you.',
    ].join(' '),
    wpm_scale: 0.85,
    lead_scale: 2,
    lead_min_ms: 1_600,
    extra_turns: 8,
    // Outside, on a bad handset, in an accent from the other side of the language.
    audio: { background: 'street', signal_to_noise_db: 9 },
    accent: 'far',
    gain: 0.7,
  },
];

export const DIFFICULTY_BY_ID = new Map(DIFFICULTIES.map((d) => [d.id, d]));

export function difficultyOf(id: string | undefined): Difficulty {
  return DIFFICULTY_BY_ID.get(id ?? 'normal') ?? DIFFICULTY_BY_ID.get('normal')!;
}

/**
 * The difficulty folded into the caller, so the prompt that gets logged is the
 * whole of what the person was told to be.
 */
export function atDifficulty(behaviour: Behaviour, difficulty: Difficulty): Behaviour {
  if (difficulty.id === 'normal') return behaviour;
  const instructions = behaviour.instructions === ''
    ? difficulty.instructions
    : `${behaviour.instructions}\n\nAnd how this particular call goes: ${difficulty.instructions}`;
  return {
    ...behaviour,
    instructions,
    wpm: Math.round(behaviour.wpm * difficulty.wpm_scale),
    lead_ms: Math.max(Math.round(behaviour.lead_ms * difficulty.lead_scale), difficulty.lead_min_ms),
    accent: difficulty.accent,
    gain: behaviour.gain * difficulty.gain,
    audio: noisier(behaviour.audio, difficulty.audio),
  };
}

/**
 * The worse of two lines, so turning the dial up never quietens a call: Easy's
 * silence wins outright because it is the one level that promises a clean line.
 */
export function noisier(theirs: AudioBed | null, level: AudioBed | null): AudioBed | null {
  if (level === null) return theirs;
  if (level.background === 'silence') return level;
  if (theirs === null || theirs.background === 'silence') return level;
  return (theirs.signal_to_noise_db ?? 99) <= (level.signal_to_noise_db ?? 99) ? theirs : level;
}
