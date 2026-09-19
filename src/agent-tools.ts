/**
 * The tools the agent may call mid-turn.
 *
 * Two rules shape all of them. A caller hears every millisecond, so each tool is one
 * request with a hard cap and returns a single short line the agent can read aloud
 * unchanged. And nothing a caller acts on is invented: a slot, a doctor, a site or a
 * plan is read off the API or the cached catalogue, and the exact strings behind it are
 * kept in call state so the submission at close quotes them rather than the transcript.
 */

import { llm } from '@livekit/agents';
import { z } from 'zod';
import {
  locationById,
  providersByName,
  siteHours,
  type Availability,
  type Catalogue,
  type ClinicApi,
} from './clinic-api.js';
import {
  recordAccepted,
  recordMatch,
  recordPatientField,
  recordQuote,
  recordRequest,
  recordThirdParty,
  readCallState,
  retract,
  type CallState,
  type PatientField,
  type QuotedSlot,
} from './call-state.js';
import { geocodeMadrid, rankSites } from './nearest-site.js';
import { resolveWhen } from './when.js';

export interface ToolDeps {
  state: CallState;
  api: ClinicApi;
  catalogue: Catalogue | null;
  /** Kept so the decider can name the standing rule that refused a booking. */
  onAvailability?: (availability: Availability) => void;
  now?: () => Date;
}

const PATIENT_FIELDS = [
  'given_name', 'first_surname', 'second_surname', 'national_id',
  'date_of_birth', 'phone', 'email', 'insurer',
] as const;

export function buildTools(deps: ToolDeps): llm.ToolContextLike {
  const { state, api, catalogue } = deps;
  const now = deps.now ?? ((): Date => new Date());

  return {
    identify_patient: llm.tool({
      description:
        'Look the patient up in the clinic directory. Call it as soon as you have a name plus one of: DNI/NIE, date of birth, or phone number. Two people share a name more often than you would think, so give everything you have.',
      parameters: z.object({
        name: z.string().optional().describe('Full name as the caller said it'),
        national_id: z.string().optional().describe('DNI or NIE including the letter'),
        date_of_birth: z.string().optional().describe('YYYY-MM-DD'),
        phone: z.string().optional().describe('Spanish phone number'),
      }),
      execute: async (args) => {
        const query = {
          name: args.name,
          national_id: args.national_id ? state.patient.national_id ?? args.national_id : undefined,
          date_of_birth: args.date_of_birth,
          phone: args.phone ?? state.patient.phone,
        };
        if (!query.name && !query.national_id && !query.date_of_birth && !query.phone) {
          return 'Nothing to search on yet — ask for a name and one identifier.';
        }
        const matches = await api.findPatient(query);
        if (matches.length === 0) return 'No record found. Treat them as a new patient unless they insist otherwise.';
        if (matches.length > 1) {
          return `${matches.length} people match that. Ask for their date of birth to tell them apart.`;
        }
        const patient = matches[0]!;
        recordMatch(state, patient);
        const visited = patient.has_visited_before ? 'has been seen here before' : 'has never been seen here';
        return `Found ${[patient.given_name, patient.first_surname].filter(Boolean).join(' ')}, ${visited}, plan on record ${patient.insurer ?? 'none'}. Do not read this back.`;
      },
    }),

    record_patient_field: llm.tool({
      description:
        'Write one detail about the patient down. Call it the moment you hear the value — every field of a new registration must go through here.',
      parameters: z.object({
        field: z.enum(PATIENT_FIELDS),
        value: z.string().describe('Exactly as the caller said it, including spelled-out letters'),
      }),
      execute: async (args) => {
        const result = recordPatientField(state, args.field as PatientField, args.value);
        return result.problem
          ? `Saved ${args.field} as ${result.value}, but ${result.problem}. Ask them for it once more.`
          : `Saved ${args.field}.`;
      },
    }),

    record_request: llm.tool({
      description:
        'Write down what the caller wants: the intent, the specialty or complaint, any doctor or site they name, when they want to come, and every insurer they mention.',
      parameters: z.object({
        intent: z.enum(['book', 'reschedule', 'cancel', 'register', 'question']).optional(),
        specialty_id: z.string().optional(),
        complaint: z.string().optional().describe("The problem in the caller's own words"),
        provider_name: z.string().optional(),
        location_id: z.string().optional(),
        when_phrase: z.string().optional().describe('The caller\'s own words, e.g. "Thursday morning"'),
        language: z.string().optional().describe('A language they asked the doctor to speak'),
        insurers: z.array(z.string()).optional().describe('Every plan named on this call'),
      }),
      execute: async (args) => {
        recordRequest(state, args);
        return 'Noted.';
      },
    }),

    record_third_party: llm.tool({
      description:
        'The caller is ringing about somebody else. Call it as soon as you know, so the appointment goes to the patient and not to the caller.',
      parameters: z.object({
        caller_is_patient: z.boolean(),
        caller_name: z.string().optional(),
        relationship: z.string().optional().describe('e.g. daughter, husband, carer'),
      }),
      execute: async (args) => {
        recordThirdParty(state, args.caller_is_patient, {
          name: args.caller_name,
          relationship: args.relationship,
        });
        return args.caller_is_patient
          ? 'Noted, they are the patient.'
          : 'Noted. Everything from here is about the patient, not the caller.';
      },
    }),

    retract_detail: llm.tool({
      description: 'The caller corrected something you already wrote down and has not yet replaced it.',
      parameters: z.object({ field: z.string() }),
      execute: async (args) => {
        retract(state, args.field as PatientField);
        return `Dropped ${args.field}.`;
      },
    }),

    read_notes: llm.tool({
      description: 'Everything you have written down so far, and what is still missing. Cheap; use it before you say goodbye.',
      execute: async () => readCallState(state),
    }),

    find_slots: llm.tool({
      description:
        'The real diary. Call it before you offer any time at all, then read back only the times it returns. Warn the caller you are checking first — it takes a moment.',
      parameters: z.object({
        when_phrase: z
          .string()
          .describe('The caller\'s words for when they want to come, e.g. "next Tuesday afternoon" or "as soon as possible"'),
        specialty_id: z.string().optional(),
        provider_name: z.string().optional(),
        location_id: z.string().optional(),
      }),
      execute: async (args) => {
        const request = recordRequest(state, {
          when_phrase: args.when_phrase,
          specialty_id: args.specialty_id,
          provider_name: args.provider_name,
          location_id: args.location_id,
        });

        let providerId = request.provider_id;
        if (args.provider_name && catalogue) {
          const found = providersByName(catalogue, args.provider_name);
          if (found.length > 1) {
            return `More than one doctor answers to that name: ${found.map((p) => `${p.name} in ${p.specialty_name ?? 'unknown'}`).join(', ')}. Ask which one they mean.`;
          }
          if (found.length === 1) {
            providerId = found[0]!.id;
            recordRequest(state, { provider_id: providerId });
          }
        }

        const window = resolveWhen(args.when_phrase, now(), {
          locationId: args.location_id ?? request.location_id,
          closureDays: catalogue?.calendar?.closure_days,
          maxSpanDays: catalogue?.calendar?.max_span_days ?? undefined,
        });
        if (window.part_of_day) recordRequest(state, { part_of_day: window.part_of_day });

        const availability = await api.findAvailability({
          date_from: window.date_from,
          date_to: window.date_to,
          provider_id: providerId,
          specialty_id: args.specialty_id ?? request.specialty_id,
          location_id: args.location_id ?? request.location_id,
          patient_id: state.matched?.patient_id,
          insurer: request.insurers.length > 0 ? request.insurers : undefined,
        });
        deps.onAvailability?.(availability);

        if (availability.slots.length === 0) {
          const blocked = availability.blocked[0]?.restriction;
          return blocked
            ? `Nothing bookable: ${blocked}. Tell the caller plainly and do not offer a time.`
            : 'Nothing free in that window. Offer to look at a different day.';
        }

        const wanted = window.part_of_day;
        const matching = wanted
          ? availability.slots.filter((s) => inPart(s.start_time, wanted))
          : availability.slots;
        const shortlist = (matching.length > 0 ? matching : availability.slots).slice(0, 3);

        const quoted: QuotedSlot[] = shortlist.map((s) => ({
          provider_id: s.provider_id,
          provider_name: s.provider_name ?? undefined,
          location_id: s.location_id,
          appointment_type_id: s.appointment_type_id,
          start_time: s.start_time,
          payable_with: s.payable_with ?? undefined,
        }));
        recordQuote(state, quoted);

        const moved = window.adjusted_from ? `The day they asked for is closed, so this is from ${window.adjusted_from}. ` : '';
        const lines = quoted.map(
          (s, i) =>
            `${i + 1}. ${speakTime(s.start_time)} with ${s.provider_name ?? s.provider_id} at ${siteName(catalogue, s.location_id)}`,
        );
        return `${moved}Offer these, and nothing else: ${lines.join('; ')}. When they pick one, call accept_slot.`;
      },
    }),

    accept_slot: llm.tool({
      description: 'The caller said yes to one of the times find_slots returned. Call it straight away, before anything else.',
      parameters: z.object({ choice: z.number().int().describe('1, 2 or 3 as you read them out') }),
      execute: async (args) => {
        const slot = state.quoted[args.choice - 1];
        if (!slot) return 'That is not one of the times you offered. Read the list again or call find_slots.';
        recordAccepted(state, slot);
        return `Held ${speakTime(slot.start_time)}. Confirm it back once, in one sentence, and move on.`;
      },
    }),

    list_appointments: llm.tool({
      description:
        'The patient\'s appointments already in the diary. Needed before moving or cancelling one: it is the only place the appointment reference comes from.',
      execute: async () => {
        const patientId = state.matched?.patient_id;
        if (!patientId) return 'Identify the patient first with identify_patient.';
        const appointments = await api.getPatientAppointments(patientId, 'upcoming');
        if (appointments.length === 0) return 'Nothing booked for them. Nothing to move or cancel.';
        recordRequest(state, { appointment_id: appointments[0]!.appointment_id });
        return appointments
          .map((a) => `${speakTime(a.start_time)} at ${siteName(catalogue, a.location_id ?? '')}`)
          .join('; ');
      },
    }),

    nearest_site: llm.tool({
      description: 'Which of the clinic\'s sites is closest to an address the caller gives you.',
      parameters: z.object({
        address: z.string().describe('The street address or neighbourhood the caller named'),
        specialty_id: z.string().optional().describe('Only rank sites that offer this'),
      }),
      execute: async (args) => {
        if (!catalogue) return 'Cannot check that from here. Take the request and let the clinic come back to them.';
        const origin = await geocodeMadrid(args.address);
        if (!origin) return 'Could not place that address. Ask which part of Madrid they are in.';
        const ranked = rankSites(catalogue, origin, { specialty_id: args.specialty_id });
        if (ranked.length === 0) return 'No site offers that. Say so plainly.';
        const [first] = ranked;
        return `Nearest is ${first!.name}, about ${first!.km} kilometres away.`;
      },
    }),

    clinic_fact: llm.tool({
      description:
        'A standing fact about the clinic: what a named doctor does and where they work, or a site\'s opening hours on a date. Never answer either from memory.',
      parameters: z.object({
        doctor_name: z.string().optional(),
        location_id: z.string().optional(),
        date: z.string().optional().describe('YYYY-MM-DD, with location_id, for opening hours'),
      }),
      execute: async (args) => {
        if (!catalogue) return 'Cannot check that from here. Tell the caller the clinic will confirm.';
        if (args.doctor_name) {
          const found = providersByName(catalogue, args.doctor_name);
          if (found.length === 0) return 'No doctor of that name here. Say so rather than guessing.';
          return found
            .map(
              (p) =>
                `${p.name}, ${p.specialty_name ?? 'unknown specialty'}, at ${p.location_names.join(' and ') || 'unknown site'}${p.languages.length > 0 ? `, speaks ${p.languages.join(' and ')}` : ''}`,
            )
            .join('; ');
        }
        if (args.location_id) {
          const site = locationById(catalogue, args.location_id);
          if (!site) return 'No site by that name.';
          if (args.date) {
            const hours = siteHours(catalogue, args.location_id, args.date);
            return hours.length > 0
              ? `${site.name} is open ${hours.join(' and ')} that day.`
              : `${site.name} is closed that day.`;
          }
          return `${site.name}${site.address ? `, ${site.address}` : ''}.`;
        }
        return 'Ask about a doctor or a site.';
      },
    }),
  };
}

function siteName(catalogue: Catalogue | null, locationId: string): string {
  if (!catalogue) return locationId;
  return locationById(catalogue, locationId)?.name ?? locationId;
}

const MADRID_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** Read aloud, never as an ISO string; the exact string stays in call state. */
export function speakTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return MADRID_TIME.format(at).replace(' at ', ', ');
}

function inPart(iso: string, part: 'morning' | 'afternoon'): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(
      new Date(iso),
    ),
  );
  return part === 'morning' ? hour < 14 : hour >= 14;
}
