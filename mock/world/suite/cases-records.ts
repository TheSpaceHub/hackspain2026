/**
 * Problems 4, 6, 8, 9 and 17 — the cases whose answer is a record other than a plain
 * booking: a registration, a refusal with the right reason on it, a change to something
 * that already exists, a booking made by somebody else, or one paid by a plan the
 * directory has never heard of.
 */
import { makeDni, makeNie } from '../../rules/national-id.js';
import { ANCHORS, type Patient } from '../people.js';
import type { Insurer } from '../catalogue.js';
import type { World } from '../world.js';
import {
  bookOf, e164, earliest, findBlocked, findPatient, fullName, isAdult, makeCase, noAction, spellOut,
} from './helpers.js';
import type { Case, ExpectedAction } from './types.js';

const GP = 'general_practice';

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`the world has no ${what} — the suite cannot be built`);
  return value;
}

// --- 4 · the new patient -----------------------------------------------------

interface Newcomer {
  given_name: string;
  first_surname: string;
  second_surname: string;
  national_id: string;
  date_of_birth: string;
  phone: string;
  email: string;
  insurer: Insurer;
}

function registerOf(n: Newcomer): ExpectedAction {
  return {
    action: 'REGISTER',
    'new_patient.given_name': n.given_name,
    'new_patient.first_surname': n.first_surname,
    'new_patient.second_surname': n.second_surname,
    'new_patient.national_id': n.national_id,
    'new_patient.date_of_birth': n.date_of_birth,
    'new_patient.phone': { present: true },
    'new_patient.email': { present: true },
    'new_patient.insurer': n.insurer,
  };
}

export function theNewPatient(): Case[] {
  const people: (Newcomer & { note: string; title: string; summary: string; twist: string[] })[] = [
    {
      given_name: 'Rocío', first_surname: 'Bermejo', second_surname: 'Andrade',
      national_id: makeDni('84920137'), date_of_birth: '1991-06-24', phone: '677201458',
      email: 'rocio.bermejo@example.es', insurer: 'sanitas',
      note: 'Moved to the area and wants to be put on the books. Nothing is wrong yet.',
      title: 'Straight registration',
      summary: 'New to the area, wants to be registered. Nothing is booked.',
      twist: ['Just being on the books is all you want today. If they offer an appointment, decline politely.'],
    },
    {
      given_name: 'Ignacio', first_surname: 'Peláez', second_surname: 'Quiroga',
      national_id: makeDni('29184756'), date_of_birth: '1966-01-09', phone: '691338702',
      email: 'i.pelaez@example.es', insurer: 'dkv',
      note: 'Rings to book, and turns out not to be on file at all.',
      title: 'Rings to book, is not on file',
      summary: 'Wants an appointment, but is not a patient yet — registration is the only record.',
      twist: [
        'You rang to book a GP appointment, but you have never been to this clinic.',
        'Give your details when they say you are not on file. Being registered is enough for today.',
      ],
    },
    {
      given_name: 'Yaroslav', first_surname: 'Kovalenko', second_surname: 'Rus',
      national_id: makeNie('Y', '4172093'), date_of_birth: '1984-11-30', phone: '632907415',
      email: 'y.kovalenko@example.es', insurer: 'asisa',
      note: 'A resident with a NIE, whose surname has to be spelled out.',
      title: 'A NIE and a spelled-out surname',
      summary: 'Foreign resident: a NIE rather than a DNI, and a surname nobody gets first time.',
      twist: [
        'Your surname is never understood down the phone. Spell it out, letter by letter, when asked.',
        'Your identifier is a NIE, not a DNI. Read it out one character at a time.',
      ],
    },
    {
      given_name: 'Amparo', first_surname: 'Del Olmo', second_surname: 'Briones',
      national_id: makeDni('60314928'), date_of_birth: '1957-03-17', phone: '618470239',
      email: 'amparo.delolmo@example.es', insurer: 'mapfre',
      note: 'Gives one digit of the DNI wrong and corrects it a turn later.',
      title: 'A corrected identifier',
      summary: 'Misreads a digit of her DNI, then corrects it — the correction is what must be recorded.',
      twist: [
        'When you first read out your DNI, change the second digit to a 1 by mistake.',
        'One turn later, say "sorry, I misread that" and give the correct one. Insist they use the corrected one.',
      ],
    },
  ];

  return people.map((n, i) =>
    makeCase('the_new_patient', {
      id: `the_new_patient-0${i + 1}`,
      problem: '',
      title: n.title,
      summary: n.summary,
      from_number: `+34${n.phone}`,
      persona: {
        name: `${n.given_name} ${n.first_surname} ${n.second_surname}`,
        voice: ['Rocío', 'Amparo'].includes(n.given_name) ? 'female' : 'male',
        description: n.note,
        data: {
          national_id: n.national_id,
          date_of_birth: n.date_of_birth,
          phone: n.phone,
          email: n.email,
          insurer: n.insurer,
          second_surname: n.second_surname,
        },
        objectives: [
          'You are not a patient of this clinic. You want to be put on their books.',
          'Give every detail they ask for, one at a time: they will ask for several.',
          ...n.twist,
        ],
      },
      script: [
        "Hello, I don't think I'm registered with you — I'd like to be.",
        `My name is ${n.given_name} ${n.first_surname} ${n.second_surname}.`,
        `My identifier is ${spellOut(n.national_id)}, and I was born on the ${n.date_of_birth}.`,
        `My number is ${spellOut(n.phone)}, my email is ${n.email.replace('@', ' at ')}, and I'm with ${n.insurer}.`,
        "That's everything, thank you. Goodbye.",
      ],
      expected: { acceptable: [{ actions: [registerOf(n)] }] },
    }),
  );
}

// --- 6 · the rules -----------------------------------------------------------

export function theRules(world: World): Case[] {
  const cat = world.catalogue;

  // Each of these is the world's own refusal, found by asking it rather than assuming.
  const tooYoung = findBlocked(world, 'not_eligible_age', () => ({ specialty: GP }), (p) => p.patient_id > 'P00006' && !isAdult(p));
  const noReferral = findBlocked(world, 'referral_required', () => ({ specialty: 'dermatology' }), (p) => p.patient_id > 'P00006' && isAdult(p));
  const notCovered = findBlocked(world, 'specialty_not_covered', () => ({ specialty: 'dermatology' }), (p) => p.patient_id > 'P00006' && p.referrals.includes('dermatology'));
  const insurerReferral = findBlocked(world, 'insurer_referral_required', () => ({ specialty: 'orthopaedics' }), (p) => p.patient_id > 'P00006' && isAdult(p));
  const spent = findBlocked(world, 'allowance_exhausted', (p) => ({ specialty: p.insurer === 'mapfre' ? 'orthopaedics' : 'physiotherapy' }), (p) => p.patient_id > 'P00006' && isAdult(p));

  const write = (
    n: number,
    patient: Patient,
    specialty: string,
    reason: string,
    title: string,
    why: string,
    ask: string,
  ): Case => {
    const name = cat.specialties.get(specialty)!.name.toLowerCase();
    return makeCase('the_rules', {
      id: `the_rules-0${n}`,
      problem: '',
      title,
      summary: `${fullName(patient)} asks for ${name}; the clinic's rules say no — ${reason}.`,
      from_number: e164(patient),
      persona: {
        name: fullName(patient),
        voice: patient.sex === 'F' ? 'female' : 'male',
        description: 'Reasonable, and does not know the rule that is about to stop them. Presses once, then accepts it.',
        data: {
          national_id: patient.national_id,
          phone: patient.phone,
          date_of_birth: patient.date_of_birth,
          insurer: patient.insurer,
          referrals: patient.referrals.join(', ') || 'none',
        },
        objectives: [
          ask,
          why,
          'If they say no, ask once why, and then accept it and end the call. Never accept a different specialty.',
          'Give your DNI when asked.',
        ],
      },
      script: [
        ask,
        `${fullName(patient)}, D N I ${spellOut(patient.national_id)}.`,
        'Why not? Is there nothing you can do?',
        'Alright, I understand. Thank you, goodbye.',
      ],
      expected: { acceptable: [{ actions: [noAction(reason)] }] },
    });
  };

  return [
    write(1, tooYoung, GP, 'not_eligible_age', 'Too young for the adult list', 'You are under fourteen — you do not know that matters.', "Hello, I'd like to book with a GP, please."),
    write(2, noReferral, 'dermatology', 'referral_required', 'No referral for a gated specialty', 'You have no referral and do not think you need one.', "Hi, I'd like a dermatology appointment please."),
    write(3, notCovered, 'dermatology', 'specialty_not_covered', 'The plan does not cover the specialty', 'You have the referral, so you are sure it is covered.', "Hello, I've got a referral for dermatology and I'd like to book."),
    write(4, insurerReferral, 'orthopaedics', 'insurer_referral_required', 'The insurer wants a referral the clinic does not', 'Your insurer wants a referral for this; you have not got one.', "Hello, I need to book orthopaedics for my shoulder."),
    write(5, spent, spent.insurer === 'mapfre' ? 'orthopaedics' : 'physiotherapy', 'allowance_exhausted', "This year's allowance is used up", 'You have had several sessions this year already.', "Hi, I'd like to book another session, please."),
  ];
}

// --- 8 · change and cancel ---------------------------------------------------

export function changeAndCancel(world: World): Case[] {
  const jorge = world.patient(ANCHORS.jorge)!;
  const upcoming = world.anchorAppointments.jorgeUpcoming;
  if (!upcoming) throw new Error('the world has no upcoming anchor appointment to change');
  const booked = world.diary.get(upcoming)!;
  // Moving it means somewhere else in the same provider's diary.
  const later = must(
    earliest(world, { provider: booked.provider_id, patient: jorge }),
    'another slot with the same provider',
  );
  const stranger = findPatient(
    world,
    (p) => p.patient_id > 'P00006' && p.has_visited_before && isAdult(p) && world.diary.forPatient(p.patient_id).every((a) => a.start_time < '2026'),
  );

  return [
    makeCase('change_and_cancel', {
      id: 'change_and_cancel-01',
      problem: '',
      title: 'Cancel the one that is coming up',
      summary: 'Jorge cancels his orthopaedics review outright.',
      from_number: e164(jorge),
      persona: {
        name: fullName(jorge),
        voice: 'male',
        description: 'Away for work that week. Wants it off the books, not moved.',
        data: { national_id: jorge.national_id, phone: jorge.phone, insurer: jorge.insurer },
        objectives: [
          'You want to cancel the appointment you have coming up. You do not want another one.',
          'If they offer to move it instead, say no — you will ring back when you are home.',
          'Give your DNI when asked.',
        ],
      },
      script: [
        "Hello, I need to cancel my appointment, please.",
        `${fullName(jorge)}, D N I ${spellOut(jorge.national_id)}.`,
        "No, don't rebook it — I'm away. Just cancel it.",
        'Thank you, goodbye.',
      ],
      expected: { acceptable: [{ actions: [{ action: 'CANCEL', appointment_id: upcoming }] }] },
    }),

    makeCase('change_and_cancel', {
      id: 'change_and_cancel-02',
      problem: '',
      title: 'Move it to the earliest there is',
      summary: 'Jorge wants the same doctor, sooner — a reschedule, not a cancel and a book.',
      from_number: e164(jorge),
      persona: {
        name: fullName(jorge),
        voice: 'male',
        description: 'The knee is worse. Wants to be seen sooner by the same doctor.',
        data: { national_id: jorge.national_id, phone: jorge.phone, insurer: jorge.insurer },
        objectives: [
          'You want to move the appointment you already have to the earliest slot with the same doctor.',
          'Do not agree to cancel it and start again — you want it moved.',
          'Give your DNI when asked.',
        ],
      },
      script: [
        "Hi, I've got an appointment coming up and I'd like to move it earlier.",
        `${fullName(jorge)}, D N I ${spellOut(jorge.national_id)}.`,
        'Same doctor, as early as you can. Not a new one — move the one I have.',
        'That one, yes. Thank you.',
      ],
      expected: {
        acceptable: [
          {
            actions: [
              {
                action: 'RESCHEDULE',
                appointment_id: upcoming,
                provider_id: later.slot.provider_id,
                location_id: later.slot.location_id,
                slot: later.slot.start_time,
                policy_id: jorge.insurer,
              },
            ],
          },
        ],
      },
    }),

    makeCase('change_and_cancel', {
      id: 'change_and_cancel-03',
      problem: '',
      title: 'Cancel, identified only by the line they ring from',
      summary: 'No DNI to hand: the number on the record is the only identifier offered.',
      from_number: e164(jorge),
      persona: {
        name: fullName(jorge),
        voice: 'male',
        description: 'In the car, hands full, no paperwork. Will give the phone number and nothing else.',
        data: { phone: jorge.phone, date_of_birth: jorge.date_of_birth },
        objectives: [
          'You want to cancel your upcoming appointment.',
          'You do not have your DNI: offer your phone number and your date of birth instead.',
          'Do not invent a DNI under any circumstances.',
        ],
      },
      script: [
        'Hello, can I cancel an appointment please?',
        `${fullName(jorge)}. I haven't got my DNI on me — my number is ${spellOut(jorge.phone)}.`,
        `Born on the ${jorge.date_of_birth}, yes.`,
        'Yes, cancel it. Thanks.',
      ],
      expected: { acceptable: [{ actions: [{ action: 'CANCEL', appointment_id: upcoming }] }] },
    }),

    makeCase('change_and_cancel', {
      id: 'change_and_cancel-04',
      problem: '',
      title: 'Nothing to cancel',
      summary: 'Sure they have an appointment next week; the diary says otherwise.',
      from_number: e164(stranger),
      persona: {
        name: fullName(stranger),
        voice: stranger.sex === 'F' ? 'female' : 'male',
        description: 'Certain there is an appointment next week. There is not, and they will need convincing.',
        data: { national_id: stranger.national_id, phone: stranger.phone, insurer: stranger.insurer },
        objectives: [
          'You want to cancel the appointment you believe you have next week.',
          'If they say there is nothing on the system, insist once — you are sure.',
          'Do not book anything new: you only rang to cancel.',
        ],
      },
      script: [
        'Hello, I need to cancel my appointment next week.',
        `${fullName(stranger)}, D N I ${spellOut(stranger.national_id)}.`,
        "Nothing? Are you sure? I'm certain I had one.",
        "Alright then, sorry to bother you. Goodbye.",
      ],
      expected: {
        acceptable: [
          { actions: [noAction('patient_history')] },
          { actions: [noAction('out_of_scope')] },
        ],
      },
    }),
  ];
}

// --- 9 · the third party -----------------------------------------------------

export function thirdParty(world: World): Case[] {
  const elena = world.patient(ANCHORS.elena)!;
  const daniel = world.patient(ANCHORS.daniel)!;
  const antonio = world.patient(ANCHORS.antonio)!;
  const marta = world.patient(ANCHORS.marta)!;
  const child = findPatient(
    world,
    (p) => p.patient_id > 'P00006' && !isAdult(p) && p.has_visited_before && p.insurer === 'sanitas',
  );

  const forDaniel = must(earliest(world, { specialty: 'paediatrics', patient: daniel }), 'paediatrics slot for Daniel');
  const forChild = must(earliest(world, { specialty: 'paediatrics', patient: child }), 'paediatrics slot');

  return [
    makeCase('third_party', {
      id: 'third_party-01',
      problem: '',
      title: 'A mother booking for her son',
      summary: 'Elena rings for Daniel, eight years old — she may, and the booking is his.',
      from_number: e164(elena),
      persona: {
        name: fullName(elena),
        voice: 'female',
        description: 'Calm, organised, has her son\'s details written down in front of her.',
        data: {
          your_national_id: elena.national_id,
          phone: elena.phone,
          son_name: fullName(daniel),
          son_date_of_birth: daniel.date_of_birth,
          son_national_id: daniel.national_id,
          insurer: daniel.insurer,
        },
        objectives: [
          `You want the earliest paediatrics appointment for your son, ${daniel.given_name}.`,
          'Say straight away that it is for your son, not for you.',
          'Give his details when asked, and yours if they ask who is calling.',
        ],
      },
      script: [
        "Hello, I'd like to book an appointment for my son, please.",
        `He's ${fullName(daniel)}, born ${daniel.date_of_birth}. I'm his mother, ${fullName(elena)}.`,
        'Paediatrics, and the earliest you have.',
        'Yes, that one. Thank you.',
      ],
      expected: { acceptable: [{ actions: [bookOf(daniel, forDaniel.tied, daniel.insurer)] }] },
    }),

    makeCase('third_party', {
      id: 'third_party-02',
      problem: '',
      title: 'A neighbour with no standing',
      summary: 'Rings for an adult who did not ask them to, and will not be put off.',
      from_number: '+34611902845',
      persona: {
        name: 'Rosa Cuéllar',
        voice: 'female',
        description: 'Helpful to a fault, and offended at the suggestion she should not be doing this.',
        data: {
          neighbour_name: fullName(antonio),
          neighbour_date_of_birth: antonio.date_of_birth,
          your_phone: '611902845',
        },
        objectives: [
          `You want to book a GP appointment for your neighbour, ${fullName(antonio)}, who is not well.`,
          'He does not know you are ringing, and you say so if asked.',
          'If they refuse, push once — he is elderly and you are only trying to help — then accept it.',
        ],
      },
      script: [
        "Hello, I'd like to make an appointment for my neighbour, he's not well.",
        `${fullName(antonio)}, born ${antonio.date_of_birth}. I'm Rosa, from the flat downstairs.`,
        "No, he doesn't know I'm calling — I'm just trying to help.",
        'Fine, I understand. Goodbye.',
      ],
      protectedValues: [antonio.national_id, antonio.phone],
      expected: { acceptable: [{ actions: [noAction('caller_not_authorised')] }] },
    }),

    makeCase('third_party', {
      id: 'third_party-03',
      problem: '',
      title: 'A husband booking for his wife',
      summary: 'An adult patient who is not on the call and has not consented.',
      from_number: '+34622714908',
      persona: {
        name: 'Tomás Lerín',
        voice: 'male',
        description: 'Assumes a married couple counts as one person to a receptionist.',
        data: {
          wife_name: fullName(marta),
          wife_date_of_birth: marta.date_of_birth,
          your_phone: '622714908',
        },
        objectives: [
          `You want a GP appointment for your wife, ${fullName(marta)}. She is at work and asked you to ring — you think.`,
          'You cannot put her on the phone and do not have her DNI.',
          'If they refuse, say you will get her to ring herself, and end the call.',
        ],
      },
      script: [
        "Hi, I want to book an appointment for my wife.",
        `${fullName(marta)}, born ${marta.date_of_birth}. I'm her husband.`,
        "She's at work, I can't put her on. Can't you just book it?",
        "Alright, I'll get her to call. Bye.",
      ],
      protectedValues: [marta.national_id, marta.phone],
      expected: { acceptable: [{ actions: [noAction('caller_not_authorised')] }] },
    }),

    makeCase('third_party', {
      id: 'third_party-04',
      problem: '',
      title: 'A father, and a child already on file',
      summary: `A parent rings for ${fullName(child)}, a minor the clinic already knows.`,
      from_number: `+34${child.phone}`,
      persona: {
        name: `Sergio ${child.first_surname}`,
        voice: 'male',
        description: 'Ringing from the family line. Knows his child\'s details and nothing about the clinic.',
        data: {
          child_name: fullName(child),
          child_date_of_birth: child.date_of_birth,
          child_national_id: child.national_id,
          insurer: child.insurer,
        },
        objectives: [
          `You want the earliest paediatrics appointment for your child, ${child.given_name}.`,
          'Say at the start that it is for your child. Give their details, not yours.',
        ],
      },
      script: [
        "Hello, it's for my daughter — sorry, my child. I need a paediatrics appointment.",
        `${fullName(child)}, born ${child.date_of_birth}. I'm their father.`,
        'The earliest you have, please.',
        'That works. Thank you, goodbye.',
      ],
      expected: { acceptable: [{ actions: [bookOf(child, forChild.tied, child.insurer)] }] },
    }),
  ];
}

// --- 17 · the second policy --------------------------------------------------

export function secondPolicy(world: World): Case[] {
  const specialties = ['dermatology', 'orthopaedics', 'physiotherapy', 'gynaecology'];
  const used = new Set<string>();

  const cases = specialties.flatMap((specialty, i) => {
    // The plan on the record cannot pay; the one they also hold, and never mention, can.
    const patient = world.patients.find((p) => {
      if (p.patient_id <= 'P00006' || used.has(p.patient_id) || !p.second_plan || !isAdult(p)) return false;
      if (specialty === 'gynaecology' && p.sex !== 'F') return false;
      const cat = world.catalogue.specialties.get(specialty)!;
      if (cat.referral_required && !p.referrals.includes(specialty)) return false;
      const first = earliest(world, { specialty, patient: p });
      if (first) return false;
      return earliest(world, { specialty, patient: p, insurer: [p.second_plan] }) !== null;
    });
    if (!patient) return [];
    used.add(patient.patient_id);
    const second = patient.second_plan!;
    const found = must(earliest(world, { specialty, patient, insurer: [second] }), `${specialty} slot on the second plan`);
    const name = world.catalogue.specialties.get(specialty)!.name.toLowerCase();

    return [
      makeCase('second_policy', {
        id: `second_policy-0${i + 1}`,
        problem: '',
        title: `${name} on the plan nobody asked about`,
        summary: `${fullName(patient)} is refused on the plan on file, and holds a second one they never mention.`,
        from_number: e164(patient),
        persona: {
          name: fullName(patient),
          voice: patient.sex === 'F' ? 'female' : 'male',
          description:
            'Holds two policies and thinks of only the first. Will mention the second only if asked ' +
            'directly whether they have any other cover — never volunteer it.',
          data: {
            national_id: patient.national_id,
            phone: patient.phone,
            insurer_on_file: patient.insurer,
            other_policy: second,
            referrals: patient.referrals.join(', ') || 'none',
          },
          objectives: [
            `You want the earliest ${name} appointment.`,
            'Your first answer about insurance is always the plan on your record.',
            'If — and only if — they ask whether you have any other cover or another policy, say yes and name it.',
            'If they never ask, accept the refusal and end the call.',
          ],
        },
        script: [
          `Hello, I'd like to book a ${name} appointment please.`,
          `${fullName(patient)}, D N I ${spellOut(patient.national_id)}. I'm with ${patient.insurer}.`,
          `Another policy? Yes, actually — I also have ${second} through work.`,
          'Use that one then. The earliest, please. Thank you.',
        ],
        expected: {
          acceptable: [{ actions: [bookOf(patient, found.tied, second)] }],
        },
      }),
    ];
  });

  if (cases.length === 0) throw new Error('no patient in the generated world holds a usable second plan');
  return cases;
}

export function recordCases(world: World): Case[] {
  return [
    ...theNewPatient(),
    ...theRules(world),
    ...changeAndCancel(world),
    ...thirdParty(world),
    ...secondPolicy(world),
  ];
}
