/**
 * Cases nobody designed.
 *
 * The written cases test the eighteen problems as the docs describe them, which
 * means they test what someone thought of. These ask the real clinic something
 * arbitrary — this patient, that specialty, a doctor they have never seen, a day
 * that may be a Sunday — and then take whatever the platform answers as the
 * expectation. Most of the asks are impossible, which is the point: an agent that
 * only ever meets bookable requests is never asked to say no for the right reason.
 *
 * A generation is a seed and nothing else, so `?seed=7` is the same seventy calls
 * tomorrow as today, up to the clinic's own diary moving under it.
 */
import type { HarvestedPatient } from '../../../../testlab/real/harvest.js';
import { makeCase } from '../helpers.js';
import type { Case, ExpectedAction } from '../types.js';
import { bookOf, e164, fullName, noAction, type Query, RealWorld, spellOut, spokenDate } from './context.js';

/** mulberry32: a seed in, the same sequence out, on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length) % items.length]!;
}

const SAID: Record<string, string> = {
  general_practice: 'a GP',
  paediatrics: 'the children\'s doctor',
  gynaecology: 'gynaecology',
  dermatology: 'dermatology',
  orthopaedics: 'orthopaedics',
  physiotherapy: 'physiotherapy',
  cardiology: 'cardiology',
  ophthalmology: 'the eye doctor',
};

interface Ask {
  patient: HarvestedPatient;
  specialty: string;
  said: string;
  provider: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
  day: string | null;
}

function askOf(w: RealWorld, next: () => number): Ask {
  const patient = pick(next, w.snapshot.patients);
  const specialties = w.snapshot.specialties.map((s) => String(s.id));
  const specialty = specialties.length > 0 ? pick(next, specialties) : 'general_practice';
  // A named doctor a third of the time, a named site a third — neither chosen to fit.
  const provider =
    next() < 0.34 && w.snapshot.providers.length > 0
      ? (() => {
          const p = pick(next, w.snapshot.providers);
          return { id: String(p.id), name: String(p.name ?? p.id) };
        })()
      : null;
  const location =
    next() < 0.34 && w.snapshot.locations.length > 0
      ? (() => {
          const l = pick(next, w.snapshot.locations);
          return { id: String(l.id), name: String(l.name ?? l.id) };
        })()
      : null;
  // Half the time one named day, closure days and all, rather than "the soonest".
  const day = next() < 0.5 ? w.someDay(next()) : null;
  return {
    patient,
    specialty,
    said: SAID[specialty] ?? specialty.replace(/_/g, ' '),
    provider,
    location,
    day,
  };
}

function wording(ask: Ask): string {
  const bits = [`I would like an appointment for ${ask.said}`];
  if (ask.provider) bits.push(`with ${ask.provider.name}`);
  if (ask.location) bits.push(`at ${ask.location.name}`);
  bits.push(ask.day ? `on ${spokenDate(ask.day)}` : 'as soon as you have something');
  return `${bits.join(' ')}.`;
}

/**
 * What the platform says about the ask, turned into the one record that would be
 * right. An ask with no slots and no single reason behind it is dropped: "there is
 * nothing, for several different reasons" is not a fact to grade an agent against.
 */
async function expectationFor(w: RealWorld, ask: Ask): Promise<{ actions: ExpectedAction[]; note: string } | null> {
  const query: Query = {
    patient: ask.patient,
    specialty: ask.specialty,
    provider: ask.provider?.id,
    location: ask.location?.id,
    from: ask.day ?? undefined,
    to: ask.day ?? undefined,
  };
  const answer = await w.availability(query);
  if (answer.slots.length > 0) {
    const sorted = [...answer.slots].sort((a, b) => a.start_time.localeCompare(b.start_time));
    const first = sorted[0]!;
    const tied = sorted.filter((s) => s.start_time === first.start_time);
    return { actions: [bookOf(ask.patient, tied)], note: 'the earliest the platform offers for this ask' };
  }
  const reasons = new Set(answer.blocked.map((b) => b.restriction));
  if (reasons.size === 1) {
    const reason = [...reasons][0]!;
    return { actions: [noAction(reason)], note: `the platform refuses this ask: ${reason}` };
  }
  if (reasons.size === 0 && ask.day !== null) {
    // An empty named day with nothing blocking it: there is simply nothing that day.
    return { actions: [noAction('no_availability')], note: 'the named day is empty' };
  }
  return null;
}

export async function randomCases(w: RealWorld, seed: number, count: number): Promise<Case[]> {
  const next = rng(seed);
  const asks = Array.from({ length: count * 3 }, () => askOf(w, next));
  const out: Case[] = [];
  for (const ask of asks) {
    if (out.length >= count) break;
    const expectation = await expectationFor(w, ask);
    if (!expectation) continue;
    const line = wording(ask);
    const n = String(out.length + 1).padStart(2, '0');
    out.push(
      makeCase('the_real_call', {
        id: `random-${seed}-${n}`,
        problem: '',
        title: `Random: ${ask.said} for ${fullName(ask.patient)}${ask.day ? ` on ${ask.day}` : ''}`,
        summary: `${line} Whatever the platform answers to that is what the agent has to arrive at.`,
        from_number: e164(ask.patient),
        persona: {
          name: fullName(ask.patient),
          voice: ask.patient.sex === 'F' ? 'female' : 'male',
          description: 'A patient of the clinic who has decided what they want and has not checked whether it is possible.',
          data: {
            national_id: ask.patient.national_id,
            phone: ask.patient.phone,
            date_of_birth: ask.patient.date_of_birth,
            insurer: ask.patient.insurer,
          },
          objectives: [
            line,
            'If they tell you that is not possible, ask why, and take no for an answer once they have explained it.',
          ],
        },
        script: [
          `Hello. ${line}`,
          `My name is ${ask.patient.given_name} ${ask.patient.first_surname}. My D N I is ${spellOut(ask.patient.national_id)}.`,
          'Whatever you have is fine.',
          'Thank you, goodbye.',
        ],
        expected: { acceptable: [{ actions: expectation.actions, note: expectation.note }] },
      }),
    );
  }
  return out;
}
