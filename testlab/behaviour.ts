/**
 * Difficult people.
 *
 * A case says what the caller wants; a behaviour says what they are like to
 * talk to. They are orthogonal on purpose — any of the eighteen problems can be
 * re-run with a caller who will not listen, who takes ten seconds to start a
 * sentence, or who is ringing from beside a motorway — so one suite of cases
 * turns into as many hostile calls as the agent can stand.
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
      'You are not listening. You have decided what you want and you say it again, a little louder each time,',
      'whatever they ask you. Answer at most one question in three, and when you do answer, answer the one',
      'you were asked two turns ago. Never acknowledge that they have explained something to you.',
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
      'Give one small piece of information per turn, never two.',
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
    instructions: 'You are somewhere very loud and you know it: you shout, you repeat yourself, and you ask them to speak up.',
    wpm: 165,
    audio: { background: 'street', signal_to_noise_db: 0 },
  },
  {
    ...base,
    id: 'mumbler',
    label: 'Mumbles',
    description: 'Quiet, fast and half off the mouthpiece, under a room bed.',
    instructions: 'You mumble, you trail off at the end of sentences, and you say identifiers far too quickly to follow.',
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
      'You interrupt. You do not wait for them to finish a sentence, you cut in as soon as you think you know',
      'where it is going, and you are often wrong about where it was going.',
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
      'asked for is in there somewhere, once, said in passing. Never lead with it.',
    ].join(' '),
  },
  {
    ...base,
    id: 'contradicts',
    label: 'Contradicts themselves',
    description: 'Gives a wrong detail, then corrects it late in the call.',
    instructions: [
      'You get your own details wrong at first — a digit of your DNI, the day you wanted, which doctor — and you',
      'correct yourself two turns later with "no, sorry, I said that wrong". What you say last is what you mean.',
    ].join(' '),
  },
  {
    ...base,
    id: 'angry',
    label: 'Angry',
    description: 'Furious before the call began; wants a person, not a system.',
    instructions: [
      'You are angry before they pick up — you have been kept waiting before and you say so. You demand',
      'to speak to a human being, you threaten to complain and to go elsewhere, and you take any question',
      'about your details as an obstacle being put in your way. You do eventually answer, grudgingly.',
    ].join(' '),
    wpm: 185,
    gain: 1.15,
  },
  {
    ...base,
    id: 'hard_of_hearing',
    label: 'Hard of hearing',
    description: 'Mishears numbers and asks for everything twice, television on.',
    instructions: [
      'You are hard of hearing. You ask them to repeat almost everything, you mishear digits and dates and',
      'read them back wrong, and you answer the question you thought you heard rather than the one asked.',
    ].join(' '),
    wpm: 120,
    lead_ms: 1_500,
    audio: { background: 'television', signal_to_noise_db: 6 },
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
      'You do not trust telephone systems with your data. Every time they ask for an identifier you ask what',
      'it is for, who will see it, and whether this call is recorded. You give it in the end, one field at a time.',
    ].join(' '),
  },
];

export const BEHAVIOUR_BY_ID = new Map(BEHAVIOURS.map((b) => [b.id, b]));

export function behaviourOf(id: string | undefined): Behaviour {
  return BEHAVIOUR_BY_ID.get(id ?? 'cooperative') ?? BEHAVIOUR_BY_ID.get('cooperative')!;
}
