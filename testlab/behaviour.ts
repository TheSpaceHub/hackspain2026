/**
 * Difficult people.
 *
 * A case says what the caller wants; a behaviour says what they are like to
 * talk to. None of them are out to break anything: they are ordinary people
 * having an ordinary bad phone call. The two are orthogonal on purpose — any of
 * the eighteen problems can be re-run with a caller who will not listen, who
 * takes ten seconds to start a sentence, or who is ringing from beside a
 * motorway — so one suite of cases turns into as many hard calls as the agent
 * can stand.
 */
import type { AudioBed } from '../mock/world/suite/types.js';

export interface Behaviour {
  id: string;
  label: string;
  description: string;
  /** Added to the persona's own instructions; empty for a cooperative caller. */
  instructions: string;
  /** espeak-ng words per minute. 150 is ordinary speech. */
  wpm: number;
  /** Silence before they start speaking, and after they have finished. */
  lead_ms: number;
  tail_ms: number;
  /** Speak over the agent instead of waiting for it to finish. */
  barge_in: boolean;
  /** Linear gain on the caller's voice: under 1 they are hard to hear. */
  gain: number;
  /** Replaces the case's own bed when set. */
  audio: AudioBed | null;
}

const base = {
  instructions: '',
  wpm: 150,
  lead_ms: 0,
  tail_ms: 0,
  barge_in: false,
  gain: 1,
  audio: null,
} satisfies Omit<Behaviour, 'id' | 'label' | 'description'>;

export const BEHAVIOURS: Behaviour[] = [
  {
    ...base,
    id: 'cooperative',
    label: 'Cooperative',
    description: 'Answers what was asked, in order. The control.',
  },
  {
    ...base,
    id: 'wont_listen',
    label: "Won't listen",
    description: 'Talks past every question and repeats the original demand.',
    instructions: [
      'You have already decided what you need and you are set on it, so most of what they ask washes over you',
      'and you say your piece again instead. When you do take a question in, it is usually the one from a couple',
      'of turns back. Explanations do not really land, and you carry on as if you had not heard them.',
    ].join(' '),
    wpm: 175,
  },
  {
    ...base,
    id: 'slow_talker',
    label: 'Slow and halting',
    description: 'Speaks slowly, with long pauses mid-sentence and before answering.',
    instructions: [
      'You are elderly and unhurried. You think aloud before you answer, you lose your thread and pick it up',
      'again, and you say things like "let me see now" and "hold on, it is written down here somewhere".',
      'One thing at a time is as fast as you go.',
    ].join(' '),
    wpm: 95,
    lead_ms: 2_500,
    tail_ms: 1_200,
  },
  {
    ...base,
    id: 'long_silences',
    label: 'Long silences',
    description: 'Leaves eight to ten seconds of dead air before each answer.',
    instructions: [
      'You are distracted — the television is on and a child is asking you something. You take a long time to',
      'come back to the phone, and when you do you sometimes ask them to repeat what they said.',
    ].join(' '),
    lead_ms: 9_000,
    tail_ms: 2_000,
  },
  {
    ...base,
    id: 'grey_noise',
    label: 'Grey noise',
    description: 'A wall of noise on the line at 0 dB: as loud as the caller.',
    instructions:
      'You are out on the street with traffic going past, so you are half shouting, you repeat yourself because ' +
      'you are not sure they caught it, and you keep asking them to speak up.',
    wpm: 165,
    audio: { background: 'street', signal_to_noise_db: 0 },
  },
  {
    ...base,
    id: 'mumbler',
    label: 'Mumbles',
    description: 'Quiet, fast and half off the mouthpiece, under a room bed.',
    instructions:
      'You are softly spoken and a bit shy on the phone, holding it away from your mouth; you trail off at the end ' +
      'of sentences and rattle off numbers quickly because you know them by heart.',
    wpm: 195,
    gain: 0.35,
    audio: { background: 'room', signal_to_noise_db: 8 },
  },
  {
    ...base,
    id: 'talks_over',
    label: 'Talks over',
    description: 'Interrupts the agent mid-sentence on every turn.',
    instructions: [
      'You are quick and a bit impatient, so you cut in the moment you think you know where a sentence is going —',
      'often before they have got to the part that mattered, and often having guessed it wrong.',
    ].join(' '),
    wpm: 180,
    barge_in: true,
  },
  {
    ...base,
    id: 'rambler',
    label: 'Rambles',
    description: 'Long digressions with the answer buried somewhere in them.',
    instructions: [
      'You digress at length — your sister, the traffic, the last time you were in — and the thing they actually',
      'asked for comes out somewhere in the middle of all that, said in passing, because to you it is the least',
      'interesting part of the story.',
    ].join(' '),
  },
  {
    ...base,
    id: 'contradicts',
    label: 'Contradicts themselves',
    description: 'Gives a wrong detail, then corrects it late in the call.',
    instructions: [
      'You are doing this from memory and you get bits of it wrong — a digit of your DNI, the day you meant, which',
      'doctor it was — and it comes back to you a couple of turns later: "no, sorry, I said that wrong". What you',
      'say last is what you mean.',
    ].join(' '),
  },
  {
    ...base,
    id: 'angry',
    label: 'Angry',
    description: 'Furious before the call began; wants a person, not a system.',
    instructions: [
      'You were already angry before they picked up — this has gone wrong for you before and you say so. You want',
      'a human being, you say you will complain and go elsewhere, and every question about your details feels like',
      'one more hoop. You do answer them in the end, grudgingly.',
    ].join(' '),
    wpm: 185,
    gain: 1.15,
  },
  {
    ...base,
    id: 'hard_of_hearing',
    label: 'Hard of hearing',
    description: 'Struggles to hear the agent: asks for the odd thing again, television on low.',
    instructions: [
      'Your hearing is not what it was, and it is the other end of the line you struggle with — you speak',
      'perfectly clearly yourself. So you ask them to say things again now and then, especially digits and',
      'dates, you read a number back to be sure you got it right, and every so often you answer the question',
      'you thought you heard. Once something has been repeated you do take it in.',
    ].join(' '),
    wpm: 120,
    lead_ms: 1_500,
    audio: { background: 'television', signal_to_noise_db: 14 },
  },
  {
    ...base,
    id: 'in_a_hurry',
    label: 'In a hurry',
    description: 'Two minutes to spare and says so every turn.',
    instructions: [
      'You are about to walk into something and you have no time. You push for the first thing they can give',
      'you, you cut short anything that sounds like a policy, and you say "just book whatever is soonest".',
    ].join(' '),
    wpm: 190,
    barge_in: true,
  },
  {
    ...base,
    id: 'child',
    label: 'A child ringing',
    description: 'A young teenager ringing for a parent, unsure of the details.',
    instructions: [
      'You are thirteen and ringing for your mother, who told you to do it and then left the room. You are shy,',
      'you are not sure of her details, you guess at some of them, and you have to go and ask for the rest.',
    ].join(' '),
    wpm: 165,
    gain: 0.8,
  },
  {
    ...base,
    id: 'distrustful',
    label: 'Distrustful',
    description: 'Will not give identifiers until told why they are needed.',
    instructions: [
      'You are wary about giving your details down a phone line, so each time they ask for one you want to know',
      'what it is for, who sees it, and whether this is being recorded. Once you are reassured you give it, one',
      'thing at a time.',
    ].join(' '),
  },
];

export const BEHAVIOUR_BY_ID = new Map(BEHAVIOURS.map((b) => [b.id, b]));

export function behaviourOf(id: string | undefined): Behaviour {
  return BEHAVIOUR_BY_ID.get(id ?? 'cooperative') ?? BEHAVIOUR_BY_ID.get('cooperative')!;
}

/**
 * Several traits in one person, not several calls.
 *
 * Picking "talks over" and "won't listen" asks for one caller who does both at
 * once — so the instructions stack, the silences take the longest of them, the
 * noisiest room wins, and the speed is what the traits average out at.
 */
export function blendBehaviours(ids: readonly string[]): Behaviour {
  const chosen = [...new Set(ids)].map(behaviourOf).filter((b) => b.id !== 'cooperative');
  if (chosen.length === 0) return behaviourOf('cooperative');
  if (chosen.length === 1) return chosen[0]!;

  const beds = chosen.map((b) => b.audio).filter((a): a is AudioBed => a !== null);
  return {
    id: chosen.map((b) => b.id).join('+'),
    label: chosen.map((b) => b.label).join(' + '),
    description: `All at once: ${chosen.map((b) => b.description.replace(/\.$/, '')).join('; ')}.`,
    instructions: [
      'All of this is true of you at once, not one thing after another:',
      ...chosen.map((b) => `- ${b.label}: ${b.instructions || 'nothing in particular.'}`),
    ].join('\n'),
    wpm: Math.round(chosen.reduce((n, b) => n + b.wpm, 0) / chosen.length),
    lead_ms: Math.max(...chosen.map((b) => b.lead_ms)),
    tail_ms: Math.max(...chosen.map((b) => b.tail_ms)),
    barge_in: chosen.some((b) => b.barge_in),
    gain: chosen.reduce((g, b) => Math.min(g, b.gain), 1.15),
    // The worst line of the lot: the loudest room at the lowest signal-to-noise.
    audio: beds.length === 0 ? null : beds.reduce((a, b) => ((b.signal_to_noise_db ?? 99) < (a.signal_to_noise_db ?? 99) ? b : a)),
  };
}
