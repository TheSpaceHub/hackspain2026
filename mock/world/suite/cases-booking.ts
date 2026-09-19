/**
 * Problems 1, 2, 3, 5, 7, 15 and 16 — everything whose answer is a slot, and whose
 * difficulty is in finding the right one.
 *
 * Every expectation is computed from this machine's world, never written down: the
 * diaries are generated, so "the earliest orthopaedics appointment" is only knowable
 * by asking availability the same question the agent will ask it.
 */
import { addDays, todayMadrid } from '../../rules/time.js';
import { ANCHORS, type Patient } from '../people.js';
import type { World } from '../world.js';
import {
  bookOf, e164, earliest, earliestWhere, findPatient, findPatientWithSlot, fullName, isAdult,
  makeCase, minuteOf, nextWeekday, noAction, slotsFor, spellOut, tomorrow, windowEnd,
} from './helpers.js';
import type { Case } from './types.js';

const GP = 'general_practice';

/** A booking case only makes sense while the world still has a slot to give. */
function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`the world has no ${what} — the suite cannot be built`);
  return value;
}

const adult = (p: Patient): boolean => p.patient_id > 'P00006' && p.has_visited_before && isAdult(p);

/** The first adult the world can serve under this constraint, and the slot it would give them. */
function findWhere(
  world: World,
  query: Parameters<typeof earliestWhere>[1],
  fits: (s: Parameters<typeof minuteOf>[0]) => boolean,
  also: (p: Patient) => boolean = () => true,
): { patient: Patient; found: NonNullable<ReturnType<typeof earliestWhere>> } {
  for (const patient of world.patients) {
    if (!adult(patient) || !also(patient)) continue;
    const found = earliestWhere(world, { ...query, patient }, fits);
    if (found) return { patient, found };
  }
  throw new Error('no patient in the generated world can be given this appointment');
}

export function simpleBooking(world: World): Case[] {
  const marta = world.patient(ANCHORS.marta)!;
  const jorge = world.patient(ANCHORS.jorge)!;
  const thursday = nextWeekday('thursday');
  // A regular on a plan with no traps, so the only thing under test is the slot.
  const { patient: morningCaller, found: morning } = findWhere(
    world,
    { specialty: GP, location: 'centro' },
    (s) => minuteOf(s) < 14 * 60,
  );
  const { patient: weekdayCaller, found: onThursday } = findWhere(
    world,
    { specialty: GP, from: thursday, to: thursday },
    () => true,
    (p) => p.patient_id !== morningCaller.patient_id,
  );

  const first = must(earliest(world, { specialty: GP, patient: marta }), 'general practice slot');
  const ortho = must(earliest(world, { specialty: 'orthopaedics', patient: jorge }), 'orthopaedics slot');

  return [
    makeCase('simple_booking', {
      id: 'simple_booking-01',
      problem: '',
      title: 'Earliest GP, identified by DNI',
      summary: 'Marta Ruiz, a regular, wants the earliest general practice appointment.',
      from_number: '+34612345000',
      persona: {
        name: fullName(marta),
        voice: 'female',
        description: 'A patient of the clinic, cooperative and unhurried. Nothing is wrong beyond a sore throat.',
        data: {
          national_id: marta.national_id,
          phone: marta.phone,
          date_of_birth: marta.date_of_birth,
          insurer: marta.insurer,
        },
        objectives: [
          'You want the earliest general practice appointment there is. Say so in your own words.',
          'Why: a sore throat since the weekend. Two or three words if they ask, never the whole story.',
          'Give your name, and your DNI only when you are asked for an identifier.',
          'Accept the first appointment they offer that is genuinely the earliest.',
        ],
      },
      script: [
        "Hello, I'd like to book an appointment with a GP, please.",
        `My name is ${marta.given_name} ${marta.first_surname}. My D N I is ${spellOut(marta.national_id)}.`,
        "It's a sore throat, since the weekend. The earliest one you have is fine.",
        'Yes, please book that one. Thank you, goodbye.',
      ],
      expected: { acceptable: [{ actions: [bookOf(marta, first.tied, marta.insurer)] }] },
    }),

    makeCase('simple_booking', {
      id: 'simple_booking-02',
      problem: '',
      title: 'Earliest orthopaedics, identified by the line they ring from',
      summary: 'Jorge Navarro gives a phone number, not a DNI, and wants the first orthopaedics slot.',
      from_number: e164(jorge),
      persona: {
        name: fullName(jorge),
        voice: 'male',
        description: 'Direct, a little impatient. Gives his phone number when asked for an identifier, never a DNI.',
        data: { phone: jorge.phone, date_of_birth: jorge.date_of_birth, insurer: jorge.insurer },
        objectives: [
          'You want the earliest orthopaedics appointment.',
          'Why: your knee has been playing up again since the last visit.',
          'If they ask for an identifier, give your phone number. You do not have your DNI to hand.',
          'Accept the earliest slot offered.',
        ],
      },
      script: [
        'Hello, I need to see someone about my knee again. Orthopaedics.',
        `${jorge.given_name} ${jorge.first_surname}. My number is ${spellOut(jorge.phone)}.`,
        "Whatever's soonest, please.",
        'Yes, book it. Thanks, bye.',
      ],
      expected: { acceptable: [{ actions: [bookOf(jorge, ortho.tied, jorge.insurer)] }] },
    }),

    makeCase('simple_booking', {
      id: 'simple_booking-03',
      problem: '',
      title: 'A morning at a named site',
      summary: `${fullName(morningCaller)} wants a morning GP appointment at Arenal Centro.`,
      from_number: e164(morningCaller),
      persona: {
        name: fullName(morningCaller),
        voice: morningCaller.sex === 'F' ? 'female' : 'male',
        description: 'Works afternoons, so mornings only, and Centro is the site they can get to.',
        data: { national_id: morningCaller.national_id, phone: morningCaller.phone, insurer: morningCaller.insurer },
        objectives: [
          'You want a general practice appointment at Arenal Centro, in the morning — you work afternoons.',
          'The earliest morning that works is what you want.',
          'Say the site and the morning constraint when you say what you need.',
          'Give your DNI when asked.',
        ],
      },
      script: [
        "Good morning. I'd like a GP appointment at the Centro site, please.",
        `I'm ${fullName(morningCaller)}. D N I ${spellOut(morningCaller.national_id)}.`,
        'It has to be a morning — I work afternoons. The earliest morning you have.',
        'That one is fine, please book it. Thank you.',
      ],
      expected: { acceptable: [{ actions: [bookOf(morningCaller, morning.tied, morningCaller.insurer)] }] },
    }),

    makeCase('simple_booking', {
      id: 'simple_booking-04',
      problem: '',
      title: 'A named weekday',
      summary: `${fullName(weekdayCaller)} can only come on Thursday and wants the first slot that day.`,
      from_number: e164(weekdayCaller),
      persona: {
        name: fullName(weekdayCaller),
        voice: weekdayCaller.sex === 'F' ? 'female' : 'male',
        description: 'Only free on Thursdays. Otherwise cooperative and quick.',
        data: { national_id: weekdayCaller.national_id, phone: weekdayCaller.phone, insurer: weekdayCaller.insurer },
        objectives: [
          'You want a general practice appointment on Thursday — the first one that day.',
          'No other day works: you are away the rest of the week.',
          'Give your DNI when asked.',
        ],
      },
      script: [
        "Hello. I need a GP appointment, and it has to be on Thursday.",
        `${fullName(weekdayCaller)}. My D N I is ${spellOut(weekdayCaller.national_id)}.`,
        'Thursday is the only day I can do. The first one that day, please.',
        'Yes, that works. Book it, thank you.',
      ],
      expected: { acceptable: [{ actions: [bookOf(weekdayCaller, onThursday.tied, weekdayCaller.insurer)] }] },
    }),
  ];
}

/** Problem 1, five, ten and twenty times at once — the same case, dialled in a burst. */
export function switchboard(world: World): Case[] {
  const base = simpleBooking(world)[0]!;
  return [5, 10, 20].map((n) =>
    makeCase('switchboard', {
      id: `switchboard-${String(n).padStart(2, '0')}`,
      problem: '',
      title: `${n} calls at once`,
      summary: `${n} simultaneous simple bookings — every line has to be picked up and answered.`,
      from_number: base.from_number,
      persona: base.persona,
      script: base.script,
      burst: n,
      expected: base.expected,
    }),
  );
}

export function doctorAndSite(world: World): Case[] {
  const { patient: regular, found: ortiz } = findPatientWithSlot(world, adult, () => ({ provider: 'PR01' }));
  // "Dr. Iglesias": PR05 is a dermatologist, PR06 an orthopaedist named Iglesia.
  const { patient: kneeCaller, found: iglesia } = findPatientWithSlot(
    world,
    (p) => adult(p) && p.patient_id !== regular.patient_id,
    () => ({ provider: 'PR06' }),
  );
  // Dr. Requena is on sick leave; the fallback has to match specialty *and* site.
  const { patient: norteCaller, found: atNorte } = findPatientWithSlot(
    world,
    adult,
    () => ({ specialty: GP, location: 'norte' }),
  );
  // Only the site is impossible for this one: they could be seen at Sur tomorrow.
  const { patient: physioCaller } = findPatientWithSlot(
    world,
    (p) => adult(p) && p.referrals.includes('physiotherapy'),
    () => ({ specialty: 'physiotherapy', location: 'sur' }),
  );

  return [
    makeCase('doctor_and_site', {
      id: 'doctor_and_site-01',
      problem: '',
      title: 'A named doctor at a named site',
      summary: 'Asks for Dra. Ortiz at Arenal Centro by name — she works there and has room.',
      from_number: e164(regular),
      persona: {
        name: fullName(regular),
        voice: regular.sex === 'F' ? 'female' : 'male',
        description: 'Has seen Dra. Ortiz before and will not see anybody else.',
        data: { national_id: regular.national_id, phone: regular.phone, insurer: regular.insurer },
        objectives: [
          'You want an appointment with Dra. Ortiz at Arenal Centro, and nobody else.',
          'The earliest one she has is fine.',
          'Give your DNI when asked.',
        ],
      },
      script: [
        "Hello, I'd like an appointment with Dra. Ortiz at the Centro site please.",
        `${fullName(regular)}, D N I ${spellOut(regular.national_id)}.`,
        'The earliest she has, thank you.',
        'Perfect, book that. Goodbye.',
      ],
      expected: { acceptable: [{ actions: [bookOf(regular, ortiz.tied, regular.insurer)] }] },
    }),

    makeCase('doctor_and_site', {
      id: 'doctor_and_site-02',
      problem: '',
      title: 'An ambiguous name across two specialties',
      summary: '"Doctor Iglesias" is a dermatologist and an orthopaedist — the knee decides which.',
      from_number: e164(kneeCaller),
      persona: {
        name: fullName(kneeCaller),
        voice: kneeCaller.sex === 'F' ? 'female' : 'male',
        description: 'Half-remembers the doctor\'s name. Knows exactly what is wrong with the knee.',
        data: { national_id: kneeCaller.national_id, phone: kneeCaller.phone, insurer: kneeCaller.insurer },
        objectives: [
          'You want an appointment with "Doctor Iglesias" — you are sure about the name, not about the spelling.',
          'It is for your knee: it clicks and locks going up stairs and gave way last week.',
          'If asked which one you mean, say the one who deals with knees.',
          'Give your DNI when asked, and take the earliest slot.',
        ],
      },
      script: [
        "Hi, I'd like to see Doctor Iglesias, please.",
        "It's my knee — it clicks and locks going up the stairs, and it gave way last week.",
        `I'm ${fullName(kneeCaller)}, D N I ${spellOut(kneeCaller.national_id)}.`,
        'Yes, the knee one. The earliest, please. Thank you.',
      ],
      expected: { acceptable: [{ actions: [bookOf(kneeCaller, iglesia.tied, kneeCaller.insurer)] }] },
    }),

    makeCase('doctor_and_site', {
      id: 'doctor_and_site-03',
      problem: '',
      title: 'The named doctor is on leave',
      summary: 'Dr. Requena is off sick; the fallback has to be general practice at Norte, not at Centro.',
      from_number: e164(norteCaller),
      persona: {
        name: fullName(norteCaller),
        voice: norteCaller.sex === 'F' ? 'female' : 'male',
        description: 'Cannot travel: Norte is the only site they can reach. Will take another doctor there.',
        data: { national_id: norteCaller.national_id, phone: norteCaller.phone, insurer: norteCaller.insurer },
        objectives: [
          'You want Dr. Requena at Arenal Norte.',
          'If he is not available, you will see another GP — but only at Norte. You cannot get to the other sites.',
          'Give your DNI when asked, and take the earliest that fits.',
        ],
      },
      script: [
        "Good morning, I'd like an appointment with Dr. Requena at Norte.",
        `${fullName(norteCaller)}. D N I ${spellOut(norteCaller.national_id)}.`,
        "Oh, he's off? Then anyone else at Norte is fine — I can't get to the other sites.",
        'The earliest at Norte, please. Yes, book it, thank you.',
      ],
      expected: {
        acceptable: [
          { actions: [bookOf(norteCaller, atNorte.tied, norteCaller.insurer)] },
          { actions: [noAction('provider_on_leave')], note: 'Refusing outright is worse, but not wrong.' },
        ],
      },
    }),

    makeCase('doctor_and_site', {
      id: 'doctor_and_site-04',
      problem: '',
      title: 'A doctor who does not exist',
      summary: 'Insists on "Dr. Salinas", who is not in the catalogue, and will see nobody else.',
      from_number: e164(regular),
      persona: {
        name: fullName(regular),
        voice: regular.sex === 'F' ? 'female' : 'male',
        description: 'Convinced a Dr. Salinas works at the clinic. Will not be talked into another doctor.',
        data: { national_id: regular.national_id, phone: regular.phone, insurer: regular.insurer },
        objectives: [
          'You want an appointment with Dr. Salinas. Someone gave you the name.',
          'If they say there is no such doctor, do not accept anybody else: say you will check the name and ring back.',
        ],
      },
      script: [
        "Hello, I'd like to book with Dr. Salinas please.",
        `${fullName(regular)}, D N I ${spellOut(regular.national_id)}.`,
        'Salinas. S-A-L-I-N-A-S. That is the name I was given.',
        "No, I don't want anyone else. I'll check the name and call back. Goodbye.",
      ],
      expected: { acceptable: [{ actions: [noAction('provider_not_found')] }] },
    }),

    makeCase('doctor_and_site', {
      id: 'doctor_and_site-05',
      problem: '',
      title: 'The right specialty, the wrong site',
      summary: 'Wants physiotherapy at Centro; the only physio sits at Sur, and the caller will not travel.',
      from_number: e164(physioCaller),
      persona: {
        name: fullName(physioCaller),
        voice: physioCaller.sex === 'F' ? 'female' : 'male',
        description: 'Has the referral in hand. Centro is walkable; Sur is not an option at all.',
        data: {
          national_id: physioCaller.national_id,
          phone: physioCaller.phone,
          insurer: physioCaller.insurer,
          referrals: physioCaller.referrals.join(', '),
        },
        objectives: [
          'You want physiotherapy at Arenal Centro. You have a referral.',
          'You cannot get to Sur or Norte — if Centro is impossible, you would rather leave it.',
        ],
      },
      script: [
        "Hello, I've got a referral for physiotherapy and I'd like to book at Centro.",
        `I'm ${fullName(physioCaller)}, D N I ${spellOut(physioCaller.national_id)}.`,
        "Sur is no good to me, I can't travel that far. It has to be Centro.",
        "Then I'll leave it for now. Thank you, goodbye.",
      ],
      expected: {
        acceptable: [
          { actions: [noAction('location_hours')] },
          { actions: [noAction('no_availability')] },
        ],
      },
    }),
  ];
}

export function whenExactly(world: World): Case[] {
  const used = new Set<string>();
  const caller = (): Patient => {
    const { patient } = findPatientWithSlot(
      world,
      (p) => adult(p) && !used.has(p.patient_id),
      () => ({ specialty: GP }),
    );
    used.add(patient.patient_id);
    return patient;
  };

  const day = (target: string, patient: Patient, fits: (m: number) => boolean, location?: string) => {
    // A day the clinic cannot serve rolls to the next open one that still fits the ask.
    for (let i = 0; i < 10; i++) {
      const on = addDays(target, i);
      if (on > world.catalogue.calendar.ends) break;
      const found = earliestWhere(world, { specialty: GP, patient, location, from: on, to: on }, (s) => fits(minuteOf(s)));
      if (found) return found;
    }
    throw new Error(`no general practice slot on or after ${target}`);
  };

  const anyTime = (): boolean => true;
  const morning = (m: number): boolean => m < 14 * 60;

  const [a, b, c, d, e] = [caller(), caller(), caller(), caller(), caller()] as [Patient, Patient, Patient, Patient, Patient];

  const t1 = day(tomorrow(), a, anyTime);
  const t2 = day(addDays(todayMadrid(), 2), b, anyTime);
  const t3 = day(addDays(todayMadrid(), 7), c, anyTime);
  // Only Centro opens on a Saturday, and only in the morning.
  const t4 = day(nextWeekday('saturday'), d, morning, 'centro');
  // The whole network is shut on 12 October; "first thing Monday the twelfth" rolls on.
  const t5 = day('2026-10-12', e, morning);

  const write = (
    n: number,
    patient: Patient,
    phrase: string,
    found: { tied: Parameters<typeof bookOf>[1] },
    title: string,
  ): Case =>
    makeCase('when_exactly', {
      id: `when_exactly-0${n}`,
      problem: '',
      title,
      summary: `"${phrase}", resolved against site hours and the closure day.`,
      from_number: e164(patient),
      persona: {
        name: fullName(patient),
        voice: patient.sex === 'F' ? 'female' : 'male',
        description: 'Says when they want it the way people do, in words, never as a date.',
        data: { national_id: patient.national_id, phone: patient.phone, insurer: patient.insurer },
        objectives: [
          `You want a general practice appointment ${phrase}. Say it exactly that way and do not translate it into a date.`,
          'If the clinic is shut then, take the earliest on the next day it is open that still fits what you asked.',
          'Give your DNI when asked.',
        ],
      },
      script: [
        `Hello, I'd like to see a GP ${phrase}, please.`,
        `${fullName(patient)}, D N I ${spellOut(patient.national_id)}.`,
        `Yes — ${phrase}. Whatever you have then.`,
        'That one is fine. Book it, thank you.',
      ],
      expected: { acceptable: [{ actions: [bookOf(patient, found.tied, patient.insurer)] }] },
    });

  return [
    write(1, a, 'tomorrow', t1, 'Tomorrow'),
    write(2, b, 'the day after tomorrow', t2, 'The day after tomorrow'),
    write(3, c, 'a week from today', t3, 'A week from today'),
    write(4, d, 'on Saturday morning', t4, 'Saturday morning — only Centro opens'),
    write(5, e, 'first thing on Monday the twelfth of October', t5, 'The closure day rolls on'),
  ];
}

export function noSlotFree(world: World): Case[] {
  const { patient: gynCaller, found: gynLater } = findPatientWithSlot(
    world,
    (p) => adult(p) && p.sex === 'F',
    () => ({ specialty: 'gynaecology' }),
  );
  const { patient: satCaller } = findPatientWithSlot(world, adult, () => ({ specialty: GP }));
  const { patient: norteCaller } = findPatientWithSlot(
    world,
    (p) => adult(p) && p.referrals.includes('physiotherapy'),
    () => ({ specialty: 'physiotherapy', location: 'sur' }),
  );
  // Physiotherapy at Sur is the only thing that runs past two o'clock at that site.
  const { patient: tightCaller, found: afternoon } = findWhere(
    world,
    { specialty: 'physiotherapy', location: 'sur' },
    (s) => minuteOf(s) >= 14 * 60,
    (p) => p.referrals.includes('physiotherapy'),
  );

  // Gynaecology runs at 72% full against one provider, so a two-day window often has nothing.
  const soon = windowEnd(world, tomorrow(), 1);
  const gynSoon = slotsFor(world, { specialty: 'gynaecology', patient: gynCaller, from: tomorrow(), to: soon });

  return [
    makeCase('no_slot_free', {
      id: 'no_slot_free-01',
      problem: '',
      title: 'Nothing in the next two days',
      summary: 'Wants gynaecology "in the next couple of days"; the one gynaecologist is packed.',
      from_number: e164(gynCaller),
      persona: {
        name: fullName(gynCaller),
        voice: 'female',
        description: 'Would like it soon but is not in distress; will take the next thing if there is nothing this week.',
        data: { national_id: gynCaller.national_id, phone: gynCaller.phone, insurer: gynCaller.insurer },
        objectives: [
          'You want a gynaecology appointment in the next couple of days.',
          'Why: dull pain low down on one side for a fortnight.',
          'If there is nothing that soon, accept the earliest they do have.',
        ],
      },
      script: [
        "Hello, I'd like to see the gynaecologist in the next couple of days if possible.",
        `${fullName(gynCaller)}, D N I ${spellOut(gynCaller.national_id)}.`,
        "A dull pain low down on one side, for a couple of weeks.",
        'Nothing that soon? Then whatever is earliest. Yes, book that, thank you.',
      ],
      expected: {
        acceptable:
          gynSoon.length > 0
            ? [{ actions: [bookOf(gynCaller, gynSoon.filter((s) => s.start_time === gynSoon[0]!.start_time), gynCaller.insurer)] }]
            : [
                { actions: [bookOf(gynCaller, gynLater.tied, gynCaller.insurer)], note: 'The nearest thing that works.' },
                { actions: [noAction('no_availability')], note: 'Only right if the caller refuses the alternative.' },
              ],
      },
    }),

    makeCase('no_slot_free', {
      id: 'no_slot_free-02',
      problem: '',
      title: 'A window that never exists',
      summary: 'Only Saturday afternoons work — Centro is the only Saturday site and it shuts at 14:00.',
      from_number: e164(satCaller),
      persona: {
        name: fullName(satCaller),
        voice: satCaller.sex === 'F' ? 'female' : 'male',
        description: 'Works six days and is only free on Saturday afternoons. Will not take a weekday.',
        data: { national_id: satCaller.national_id, phone: satCaller.phone, insurer: satCaller.insurer },
        objectives: [
          'You want a general practice appointment on a Saturday afternoon.',
          'No weekday works, and Saturday morning does not either — you are only free after lunch.',
          'If they cannot do it, leave it: say you will sort something else out.',
        ],
      },
      script: [
        'Hello. I need a GP appointment on a Saturday afternoon, please.',
        `${fullName(satCaller)}, D N I ${spellOut(satCaller.national_id)}.`,
        'No, weekdays are impossible, and mornings are out. Only Saturday after lunch.',
        "Nothing at all? Alright. I'll sort something else out. Goodbye.",
      ],
      expected: { acceptable: [{ actions: [noAction('no_availability')] }, { actions: [noAction('location_hours')] }] },
    }),

    makeCase('no_slot_free', {
      id: 'no_slot_free-03',
      problem: '',
      title: 'A specialty that is nowhere near them',
      summary: 'Physiotherapy at Norte: the only physio sits at Sur, so the window is empty by construction.',
      from_number: e164(norteCaller),
      persona: {
        name: fullName(norteCaller),
        voice: norteCaller.sex === 'F' ? 'female' : 'male',
        description: 'Has a referral and assumes every site does everything.',
        data: {
          national_id: norteCaller.national_id,
          phone: norteCaller.phone,
          insurer: norteCaller.insurer,
          referrals: norteCaller.referrals.join(', '),
        },
        objectives: [
          'You want physiotherapy at Arenal Norte, as soon as possible.',
          'If they offer Sur, ask whether there is really nothing at Norte; then decline and leave it.',
        ],
      },
      script: [
        "Hi, I've got a physio referral. Can I book at Norte?",
        `${fullName(norteCaller)}, D N I ${spellOut(norteCaller.national_id)}.`,
        'Only at Sur? Are you sure there is nothing at Norte?',
        "Then leave it, thank you. Goodbye.",
      ],
      expected: {
        acceptable: [{ actions: [noAction('no_availability')] }, { actions: [noAction('location_hours')] }],
      },
    }),

    makeCase('no_slot_free', {
      id: 'no_slot_free-04',
      problem: '',
      title: 'Negotiating the nearest thing that works',
      summary: 'Wants a physiotherapy session at Sur in the afternoon, and will take the first one that fits.',
      from_number: e164(tightCaller),
      persona: {
        name: fullName(tightCaller),
        voice: tightCaller.sex === 'F' ? 'female' : 'male',
        description: 'Flexible on the day, immovable on the time: afternoons at Sur only.',
        data: { national_id: tightCaller.national_id, phone: tightCaller.phone, insurer: tightCaller.insurer },
        objectives: [
          'You want a physiotherapy session at Arenal Sur, in the afternoon. You have a referral.',
          'Any day is fine as long as it is an afternoon at Sur. Take the earliest one that fits.',
        ],
      },
      script: [
        "Hello, I've a referral for physio and I'd like an afternoon at Sur.",
        `${fullName(tightCaller)}, D N I ${spellOut(tightCaller.national_id)}.`,
        'Any day, as long as it is an afternoon at Sur.',
        'That works, book it please. Thank you.',
      ],
      expected: { acceptable: [{ actions: [bookOf(tightCaller, afternoon.tied, tightCaller.insurer)] }] },
    }),
  ];
}

/** Straight-line distance, the way the ground truth is defined — not a routing API's. */
function km(a: { latitude: number; longitude: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.latitude - b.lat) * 111;
  const dLon = (a.longitude - b.lon) * 111 * Math.cos((b.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

export function nearestSite(world: World): Case[] {
  const cat = world.catalogue;
  const sites = [...cat.locations.values()];

  /** The nearest site that can actually serve the request, which is not always the nearest. */
  const nearestServing = (origin: { lat: number; lon: number }, specialty: string): string => {
    const serving = sites.filter((l) =>
      cat.providersOf(specialty).some((p) => p.schedules.some((s) => s.location_id === l.id)),
    );
    return serving.sort((x, y) => km(x, origin) - km(y, origin))[0]!.id;
  };

  const origins = [
    { address: 'Calle de Madrid 54, in Getafe', lat: 40.3083, lon: -3.7325, specialty: GP, insurer: 'sanitas' as const },
    { address: 'Calle de Bravo Murillo 200, in Madrid', lat: 40.4601, lon: -3.7012, specialty: GP, insurer: 'adeslas' as const },
    { address: 'Plaza Mayor 3, in Madrid', lat: 40.4155, lon: -3.7074, specialty: 'orthopaedics', insurer: 'asisa' as const },
    // Gynaecology only sits at Centro, so the nearest site is never the answer from the south.
    { address: 'Avenida de los Rosales 12, in Leganés', lat: 40.3272, lon: -3.7635, specialty: 'gynaecology', insurer: 'sanitas' as const },
  ];

  return origins.map((o, i) => {
    const wantsGyn = o.specialty === 'gynaecology';
    const site = nearestServing(o, o.specialty);
    const { patient, found } = findPatientWithSlot(
      world,
      (p) => p.patient_id > 'P00006' && p.has_visited_before && isAdult(p) && (!wantsGyn || p.sex === 'F'),
      () => ({ specialty: o.specialty, location: site }),
    );
    const specialtyName = cat.specialties.get(o.specialty)!.name.toLowerCase();

    return makeCase('nearest_site', {
      id: `nearest_site-0${i + 1}`,
      problem: '',
      title: `From ${o.address.split(',')[0]}`,
      summary: `Gives an address, not a site, and wants the closest clinic that does ${specialtyName}.`,
      from_number: e164(patient),
      persona: {
        name: fullName(patient),
        voice: patient.sex === 'F' ? 'female' : 'male',
        description: 'Does not know the clinic has more than one site; says where they live and asks for the closest.',
        data: { national_id: patient.national_id, phone: patient.phone, insurer: patient.insurer, address: o.address },
        objectives: [
          `You want a ${specialtyName} appointment at whichever of their clinics is closest to you.`,
          `You are at ${o.address}. Say the address when you ask which site is nearest.`,
          'Take the earliest appointment at whichever site they say is closest.',
        ],
      },
      script: [
        `Hello, I'd like a ${specialtyName} appointment at whichever of your clinics is nearest to me.`,
        `I'm at ${o.address}.`,
        `${fullName(patient)}, D N I ${spellOut(patient.national_id)}.`,
        'Yes, that site is fine. The earliest there, please. Thank you.',
      ],
      expected: { acceptable: [{ actions: [bookOf(patient, found.tied, patient.insurer)] }] },
    });
  });
}

export function theQuestions(world: World): Case[] {
  const used = new Set<string>();
  const fresh = (p: Patient): boolean => adult(p) && !used.has(p.patient_id);
  const take = <T extends { patient: Patient }>(got: T): T => {
    used.add(got.patient.patient_id);
    return got;
  };

  // Saturday exists only at Centro, and only in the morning.
  const sat = nextWeekday('saturday');
  const { patient: satCaller, found: saturday } = take(
    findWhere(world, { specialty: GP, location: 'centro', from: sat, to: sat }, (s) => minuteOf(s) < 14 * 60, fresh),
  );
  // Among the GPs only Dra. Ortiz speaks Catalan.
  const { patient: langCaller, found: catalanGp } = take(
    findPatientWithSlot(world, fresh, () => ({ provider: 'PR01' })),
  );
  // Centro is the only site open into the evening, and only dermatology sits that late.
  const { patient: lateCaller, found: evening } = take(
    findWhere(
      world,
      { specialty: 'dermatology', location: 'centro' },
      (s) => minuteOf(s) >= 17 * 60,
      (p) => fresh(p) && p.referrals.includes('dermatology'),
    ),
  );
  const { patient: siteCaller, found: sur } = take(
    findPatientWithSlot(world, fresh, () => ({ specialty: GP, location: 'sur' })),
  );
  // Paediatrics sits at Centro, Norte and Sur — the parent asks which and books there.
  const { patient: child, found: paeds } = findPatientWithSlot(
    world,
    (p) => p.patient_id > 'P00006' && !isAdult(p) && p.has_visited_before,
    () => ({ specialty: 'paediatrics', location: 'norte' }),
  );
  const { patient: childParent } = take(findPatientWithSlot(world, fresh, () => ({ specialty: GP })));

  const write = (
    n: number,
    patient: Patient,
    subject: Patient,
    question: string,
    then: string,
    found: { tied: Parameters<typeof bookOf>[1] },
    title: string,
  ): Case =>
    makeCase('the_questions', {
      id: `the_questions-0${n}`,
      problem: '',
      title,
      summary: `Asks ${question} before committing, and books on the answer.`,
      from_number: e164(patient),
      persona: {
        name: fullName(patient),
        voice: patient.sex === 'F' ? 'female' : 'male',
        description: 'Will not commit to anything until the question is answered. Then acts on the answer given.',
        data: {
          national_id: patient.national_id,
          phone: patient.phone,
          insurer: patient.insurer,
          ...(subject === patient ? {} : { booking_for: fullName(subject), their_date_of_birth: subject.date_of_birth }),
        },
        objectives: [
          `Before anything else, ask ${question}.`,
          'Believe whatever you are told, and act on it exactly.',
          then,
          'Give your DNI when asked.',
        ],
      },
      script: [
        `Hello. Before I book anything — ${question}?`,
        `${fullName(patient)}, D N I ${spellOut(patient.national_id)}.`,
        then,
        'Yes, that one. Book it, thank you.',
      ],
      expected: { acceptable: [{ actions: [bookOf(subject, found.tied, patient.insurer)] }] },
    });

  return [
    write(1, satCaller, satCaller, 'which of your sites opens on a Saturday', 'Book a GP appointment on Saturday morning at whichever site opens then.', saturday, 'Which site opens on Saturday'),
    write(2, langCaller, langCaller, 'which of your GPs speaks Catalan', 'Book with the GP they name, the earliest they have.', catalanGp, 'Which GP speaks Catalan'),
    write(3, lateCaller, lateCaller, 'which site is open latest in the evening', 'Book a dermatology appointment at that site, in the evening — you have a referral.', evening, 'Which site opens latest'),
    write(4, siteCaller, siteCaller, 'how many sites you have and which one is furthest south', 'Book a GP appointment at the southern site, earliest available.', sur, 'How many sites, and which is south'),
    write(5, childParent, child, 'which sites the paediatrician covers', `Book the earliest paediatrics appointment for ${fullName(child)} at Norte.`, paeds, 'Where the paediatrician sits'),
  ];
}

export function bookingCases(world: World): Case[] {
  return [
    ...simpleBooking(world),
    ...switchboard(world),
    ...doctorAndSite(world),
    ...whenExactly(world),
    ...noSlotFree(world),
    ...nearestSite(world),
    ...theQuestions(world),
  ];
}
