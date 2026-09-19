import { makeDni } from '../mock/rules/national-id.js';
import type { Clinic } from './clinic.js';
import type { ExpectedAction, Scenario } from '../mock/world/scenarios.js';

function spacedId(id: string): string {
  return `${id.slice(0, -1).split('').join(' ')}, ${id.slice(-1)}`;
}

function wrongCheckLetter(id: string): string {
  const correct = id.slice(-1);
  return correct === 'A' ? 'B' : 'A';
}

function expected(action: ExpectedAction): ExpectedAction[] {
  return [action];
}

export function simScenarios(clinic: Clinic): Scenario[] {
  const newPatientId = makeDni('73418265');
  const badDniId = makeDni('29581734');
  const wrongPersonId = makeDni('64027193');
  const cancelAppointment = clinic.upcomingAppointment('P02410')?.appointment_id ?? '';

  return [
    {
      name: 'simple',
      problem: '1 · The Simple Booking',
      summary: 'Juan Molina books the earliest dermatology appointment.',
      from_number: '+34728270443',
      script: [
        "Hello, I'd like to book a dermatology appointment, please.",
        'The earliest one you have is fine, any site.',
        'Yes, please book that one. Thank you, goodbye.',
      ],
      expect: expected({ action: 'BOOK', patient_id: 'P00367', appointment_type_id: 'dermatology_review', policy_id: 'axa' }),
    },
    {
      name: 'new-patient',
      problem: '4 · The New Patient',
      summary: 'Lucía Fernández Moreno registers without booking an appointment.',
      from_number: null,
      script: [
        "Hi, I'm new to the clinic and I'd like to register as a patient.",
        'My name is Lucía Fernández Moreno. Fernández with a z, then Moreno.',
        `My D N I is ${spacedId(newPatientId)}.`,
        'I was born on the seventeenth of May, nineteen ninety four.',
        'My phone is six five five, one two three, nine eight seven.',
        'My email is lucia dot fernandez at gmail dot com.',
        'My insurance is Sanitas.',
        "No, I don't need an appointment right now, just the registration. Goodbye.",
      ],
      expect: expected({ action: 'REGISTER', 'new_patient.national_id': newPatientId, 'new_patient.insurer': 'sanitas' }),
    },
    {
      name: 'bad-dni',
      problem: '4 · The Repeated DNI',
      summary: 'Pablo Ortega Ruiz corrects a DNI whose first check letter was wrong.',
      from_number: null,
      script: [
        "Hi, I'm new to the clinic and I'd like to register as a patient.",
        'My name is Pablo Ortega Ruiz.',
        `My D N I is ${badDniId.slice(0, -1).split('').join(' ')}, ${wrongCheckLetter(badDniId)}.`,
        'Sorry, let me say that again slowly.',
        `My D N I is ${spacedId(badDniId)}.`,
        'I was born on the third of March, nineteen eighty eight.',
        'My phone is six one one, two two two, three three three.',
        'My email is pablo dot ortega at gmail dot com.',
        'My insurance is Cigna.',
        "No, I don't need an appointment right now, just the registration. Goodbye.",
      ],
      expect: expected({ action: 'REGISTER', 'new_patient.national_id': badDniId, 'new_patient.insurer': 'cigna' }),
    },
    {
      name: 'network',
      problem: '5 · The Network Restriction',
      summary: 'José Molina accepts another dermatologist after Iglesias is blocked for DKV.',
      from_number: '+34691197258',
      script: [
        "Hello, I'd like to see Doctor Iglesias, the dermatologist, please.",
        'Oh, I see. Any other dermatologist who takes DKV is fine then, the earliest you have.',
        'Yes, book that one please. Goodbye.',
      ],
      expect: expected({ action: 'BOOK', patient_id: 'P00637', appointment_type_id: 'dermatology_review', policy_id: 'dkv' }),
    },
    {
      name: 'not-covered',
      problem: '6 · The Rules',
      summary: 'José Castro learns that Caser does not cover dermatology.',
      from_number: '+34660331217',
      script: [
        "Good morning, I'd like a dermatology appointment, I have a referral from my GP.",
        "Oh, Caser doesn't cover it? That's a shame. Thank you anyway, goodbye.",
      ],
      expect: expected({ action: 'NO_ACTION', reason: 'specialty_not_covered' }),
    },
    {
      name: 'no-referral',
      problem: '6 · Referral Required',
      summary: 'Helen Walker declines to book until she gets a dermatology referral.',
      from_number: '+34783145301',
      script: [
        "Hi, I'd like to book a dermatology appointment please.",
        "No, I don't have a referral. Okay, I'll get one from my GP first then. Thanks, bye.",
      ],
      expect: expected({ action: 'NO_ACTION', reason: 'referral_required' }),
    },
    {
      name: 'third-party',
      problem: '9 · The Third Party',
      summary: 'Catherine Smith books orthopaedics for her daughter.',
      from_number: '+34618671923',
      script: [
        "Hello, I'm calling for my daughter Catherine, not for me.",
        "I'm her mother. She needs an orthopaedics appointment, her knee is still sore.",
        'The earliest is fine. Yes, please book it for Catherine. Thank you, goodbye.',
      ],
      expect: expected({ action: 'BOOK', patient_id: 'P01693', appointment_type_id: 'orthopaedic_review' }),
    },
    {
      name: 'cancel',
      problem: '8 · Change and Cancel',
      summary: 'Juan Martín cancels his upcoming review appointment.',
      from_number: '+34788925511',
      script: [
        "Hello, I need to cancel my appointment.",
        "It's the one on the twenty-eighth of September, with Doctor Sáez. I can't make it.",
        "Yes, please cancel it. No, I don't want to rebook. Thank you, goodbye.",
      ],
      expect: expected({ action: 'CANCEL', appointment_id: cancelAppointment }),
    },
    {
      name: 'triage',
      problem: '10 · Triage',
      summary: 'José Hernández describes a medical emergency.',
      from_number: '+34713775662',
      script: [
        "Hello, I need a doctor. I've got a tight pain right across my chest.",
        "And I can't catch my breath, it started twenty minutes ago.",
        'Okay. Okay, I understand.',
      ],
      expect: expected({ action: 'ESCALATE', reason: 'medical_emergency' }),
    },
    {
      name: 'spanish',
      problem: '2 · Spanish Caller',
      summary: 'Juan Molina books the earliest general practice review in Spanish.',
      lang: 'es',
      from_number: '+34790305341',
      script: [
        'Hola, buenos días. Quería pedir cita con el médico de cabecera, por favor.',
        'La primera que tenga me viene bien, en cualquier centro.',
        'Sí, perfecto, resérvela. Muchas gracias, adiós.',
      ],
      expect: expected({ action: 'BOOK', patient_id: 'P00765', appointment_type_id: 'review', policy_id: 'privado' }),
    },
    {
      name: 'silent',
      problem: '3 · The Silent Caller',
      summary: 'Juan Rodríguez waits through the silence and then accepts dermatology.',
      from_number: '+34791667233',
      script: [
        "Hello, I'd like the earliest dermatology appointment please, any site.",
        '[pause 32]',
        'Yes, that one is fine, book it please. Goodbye.',
      ],
      expect: expected({ action: 'BOOK', patient_id: 'P01222', appointment_type_id: 'dermatology_review', policy_id: 'axa' }),
    },
    {
      name: 'wrong-person',
      problem: '9 · The Wrong Person',
      summary: "Sara López Vidal registers from Juan Molina's number after correcting the caller match.",
      from_number: '+34728270443',
      script: [
        "Hi, I'm new here and I'd like to register. No, I'm not Juan, this is his flatmate's phone.",
        'My name is Sara López Vidal.',
        `My D N I is ${spacedId(wrongPersonId)}.`,
        'Born on the ninth of October, nineteen ninety one.',
        'My phone is six two two, four four four, five five five.',
        'Email sara dot lopez at gmail dot com.',
        'Insurance AXA.',
        "That's all, thank you, goodbye.",
      ],
      expect: expected({ action: 'REGISTER', 'new_patient.national_id': wrongPersonId }),
    },
  ];
}
