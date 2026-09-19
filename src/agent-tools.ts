/**
 * The tools the agent may call mid-turn.
 *
 * Two rules shape all of them. A caller hears every millisecond, so each tool is one
 * request with a hard cap and returns a single short line the agent can read aloud
 * unchanged — and a tool exists at all only when the agent cannot answer without its
 * result, since every call costs a second pass of the dialogue model before the caller
 * hears a word. Note-taking does not qualify and runs beside the call in `extract.ts`.
 * And nothing a caller acts on is invented: a slot, a doctor, a site or a plan is read
 * off the API or the cached catalogue, and the exact strings behind it are kept in call
 * state so the submission at close quotes them rather than the transcript.
 */

import { llm } from '@livekit/agents';
import { z } from 'zod';
import {
  locationById,
  planByName,
  providersByName,
  siteHours,
  specialtyByName,
  type Availability,
  type Catalogue,
  type ClinicApi,
} from './clinic-api.js';
import {
  knownPlans,
  recordAccepted,
  recordMatch,
  recordQuote,
  recordRequest,
  retract,
  saidTimes,
  sameClock,
  type CallState,
  type QuotedSlot,
} from './call-state.js';
import { attachBrief, describeBrief } from './patient-brief.js';
import { geocodeMadrid, rankSites, type Placed } from './nearest-site.js';
import { resolveWhen } from './when.js';
import { clog } from './log.js';

export interface ToolDeps {
  state: CallState;
  api: ClinicApi;
  catalogue: Catalogue | null;
  /** Kept so the decider can name the standing rule that refused a booking. */
  onAvailability?: (availability: Availability) => void;
  now?: () => Date;
  lastCallerText?: () => string | undefined;
  /** Per-tool wall clock. Past it the agent is told to move on, mid-flight or not. */
  timeoutMs?: number;
  /**
   * Reserve a slot the caller accepted, before it is confirmed to them. A string is a
   * refusal to say why. Only the local sim provides one (see sim-holds.ts).
   */
  hold?: (slot: QuotedSlot) => Promise<string | null>;
  /** The address geocoder. Overridable so tests place an address without a network. */
  geocode?: (address: string) => Promise<Placed | null>;
}

/**
 * A tool that has not answered by now is a tool the caller is listening to silence for:
 * every millisecond past this is dead air on the line, and a lookup that eventually
 * arrives is worth less than a sentence that arrives on time. The agent gets a line it
 * can say out loud, and the request is left to settle or fail on its own.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 4_000;

const SLOW = 'That is taking too long to come back. Tell them the system is slow, and either try again or take their number.';

async function capped<T>(name: string, ms: number, work: Promise<T> | T): Promise<T | string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work).catch((err: unknown) => {
        clog.error(`[tool ${name}] ${String(err)}`);
        return 'That lookup failed. Say the system is playing up, and offer to take their number.';
      }),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(SLOW), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Small models fill required-looking fields with `"unknown"` rather than leaving them
 * out, and looking a patient called Unknown up is a wasted second of the caller's time.
 */
const PLACEHOLDERS = new Set(['unknown', 'n/a', 'na', 'none', 'null', 'undefined', '']);

function real(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return PLACEHOLDERS.has(value.trim().toLowerCase()) ? undefined : value;
}

/**
 * A spoken filter as an id the clinic knows, or nothing at all. Without the catalogue
 * there is nothing to check a guess against, so the guess does not travel.
 */
function resolve(
  catalogue: Catalogue | null,
  spoken: string | undefined,
  lookup: (catalogue: Catalogue, spoken: string) => string | undefined,
): string | undefined {
  const said = real(spoken);
  if (said === undefined || !catalogue) return undefined;
  return lookup(catalogue, said);
}

/** Plans the clinic actually sells. A misheard insurer is dropped, not priced against. */
function knownPlanIds(catalogue: Catalogue | null, spoken: string[]): string[] {
  if (!catalogue) return [];
  const ids = spoken.map((plan) => planByName(catalogue, plan)?.id).filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}

export function buildTools(deps: ToolDeps): llm.ToolContextLike {
  const { state, api, catalogue } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  const tools = {
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
          name: real(args.name),
          national_id: real(args.national_id) ? state.patient.national_id ?? args.national_id : undefined,
          date_of_birth: real(args.date_of_birth),
          phone: real(args.phone) ?? state.patient.phone,
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
        recordMatch(state, patient, undefined, 'lookup');
        attachBrief(state, catalogue, now());
        const visited = patient.has_visited_before ? 'has been seen here before' : 'has never been seen here';
        const brief = state.brief ? describeBrief(state.brief) : '';
        return `Found ${[patient.given_name, patient.first_surname].filter(Boolean).join(' ')}, ${visited}, plan on record ${patient.insurer ?? 'none'}.${brief ? ` ${brief}` : ''} Do not read this back.`;
      },
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
        // The model says "general practice" and "Centro"; the diary takes
        // `general_practice` and `loc_centro`, and rejects the whole query otherwise. A
        // filter we cannot resolve is dropped rather than sent: a wider search still
        // answers the caller, a 422 does not.
        const request0 = state.request;
        const saidSpecialty = real(args.specialty_id) ?? request0.specialty_id;
        const saidLocation = real(args.location_id) ?? request0.location_id;
        let specialty = resolve(catalogue, saidSpecialty, (c, v) => specialtyByName(c, v)?.id);
        let specialtyNote = '';
        const location = resolve(catalogue, saidLocation, (c, v) => locationById(c, v)?.id);

        const request = recordRequest(state, {
          when_phrase: args.when_phrase,
          specialty_id: specialty,
          provider_name: args.provider_name,
          location_id: location,
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
            // A doctor has one department; the diary answers `no matching provider` to
            // any other, so the doctor's own department is the one we ask for.
            const own = found[0]!.specialty_id ?? undefined;
            if (own && specialty && own !== specialty) {
              specialtyNote = ` Note: ${found[0]!.name} works in ${found[0]!.specialty_name ?? own}, not ${specialty}; tell the caller if that is not what they expected.`;
            }
            if (own) {
              specialty = own;
              recordRequest(state, { specialty_id: own });
            }
          }
        }

        // A site we cannot place is not a wider search: the caller asked to be seen
        // somewhere, and quoting another site without saying so reads as a lie.
        if (saidLocation && !location) {
          const sites = catalogue?.locations.map((l) => l.name).join(', ');
          return `No site here goes by "${saidLocation}". Ask which one they mean${sites ? `: ${sites}` : ''}.`;
        }

        // The diary refuses a query with neither: "availability needs provider_id or
        // specialty_id", a 422 the caller hears as "the system is playing up". Dropping
        // an unresolvable specialty is right, but going on to ask anyway is not.
        if (!providerId && !specialty) {
          const names = catalogue?.specialties.map((s) => s.name).join(', ');
          return saidSpecialty
            ? `No department here goes by "${saidSpecialty}". Ask which one they need${names ? `: ${names}` : ''}.`
            : `The diary needs a department or a doctor before it will answer. Ask what the appointment is for${names ? `; we have ${names}` : ''}.`;
        }

        const plans = knownPlanIds(catalogue, request.insurers);

        const window = resolveWhen(args.when_phrase, now(), {
          locationId: location,
          closureDays: catalogue?.calendar?.closure_days,
          maxSpanDays: catalogue?.calendar?.max_span_days ?? undefined,
        });
        if (window.part_of_day) recordRequest(state, { part_of_day: window.part_of_day });

        const availability = await api.findAvailability({
          date_from: window.date_from,
          date_to: window.date_to,
          provider_id: providerId,
          // Unresolved is dropped, never forwarded: "gynecology" for `gynaecology` is a
          // 404 and "sonita" for sanitas a 422, and a wider search still answers them.
          specialty_id: specialty,
          location_id: location,
          patient_id: state.matched?.patient_id,
          insurer: plans.length > 0 ? plans : undefined,
        });
        deps.onAvailability?.(availability);

        if (availability.slots.length === 0) {
          const blocked = availability.blocked.map((entry) => entry.restriction).join('; ');
          if (blocked) {
            recordRequest(state, { blocked_by: blocked });
            clog.warn(`[find_slots] blocked: ${blocked}`);
          }
          return (blocked
            ? `Nothing bookable: ${blocked}. Tell the caller plainly and do not offer a time.`
            : 'Nothing free in that window. Offer to look at a different day.') + specialtyNote;
        }

        if (state.request.blocked_by) retract(state, 'blocked_by');
        const wanted = window.part_of_day;
        const matching = wanted
          ? availability.slots.filter((s) => inPart(s.start_time, wanted))
          : availability.slots;
        // Nothing in the half of the day they asked for is worth saying out loud: a
        // caller who wanted the afternoon and hears ten forty-five thinks they were
        // ignored, not accommodated.
        const elsewhere = wanted !== undefined && matching.length === 0;
        const inOrder = [...(elsewhere ? availability.slots : matching)].sort((a, b) =>
          a.start_time.localeCompare(b.start_time),
        );
        // Someone who asked for the soonest gets the soonest, not a menu: read three out
        // and they pick the one they heard last, which is a later appointment than the
        // one they rang for. Alternatives come after they turn this one down.
        const shortlist = inOrder.slice(0, window.earliest ? 1 : 3);

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
        const partNote = elsewhere ? `Nothing in the ${wanted} that day, so say so before you offer these. ` : '';
        // The warning is a sentence the model forgets two turns later; the half of the
        // day rides on each time instead, so a slot read back out is still labelled.
        const lines = quoted.map((s, i) => {
          const half = elsewhere ? ` (${inPart(s.start_time, 'morning') ? 'morning' : 'afternoon'})` : '';
          return `${i + 1}. ${speakTime(s.start_time)}${half} with ${s.provider_name ?? s.provider_id} at ${siteName(catalogue, s.location_id)}`;
        });
        return (window.earliest
          ? `${moved}${partNote}The soonest there is: ${lines[0]}. Offer that one and no other. When they say yes, call accept_slot. Only if they turn it down, ask which day would suit and look again.`
          : `${moved}${partNote}Offer these, and nothing else: ${lines.join('; ')}. When they pick one, call accept_slot.`) + specialtyNote;
      },
    }),

    accept_slot: llm.tool({
      description: 'The caller said yes to one of the times find_slots returned. Call it straight away, before anything else.',
      // The model sends "3" as often as 3, and a rejected call is a silent turn.
      parameters: z.object({ choice: z.coerce.number().int().describe('1, 2 or 3 as you read them out') }),
      execute: async (args) => {
        let slot = state.quoted[args.choice - 1];
        if (!slot) return 'That is not one of the times you offered. Read the list again or call find_slots.';
        const callerText = deps.lastCallerText?.();
        const spoken = callerText ? saidTimes(callerText) : [];
        if (spoken.length > 0) {
          const matches = [...new Set(
            spoken.flatMap((said) =>
              state.quoted.filter((quoted) => sameClock(quoted, said)),
            ),
          )];
          if (matches.length === 1) {
            if (matches[0] !== slot) {
              clog.warn(
                `[accept_slot] corrected choice ${args.choice} to ${state.quoted.indexOf(matches[0]!) + 1} for caller time ${formatClock(spoken[0]!)}`,
              );
              slot = matches[0]!;
            }
          } else if (matches.length === 0) {
            const spokenText = spoken.map(formatClock).join(', ');
            clog.warn(
              `[accept_slot] refused: caller said ${spokenText}, choice ${args.choice} is ${formatClock(clockForLog(slot.start_time))}`,
            );
            return `The caller said ${spokenText} but that was never offered. The diary has only: ${state.quoted.map((quoted) => speakTime(quoted.start_time)).join('; ')}. Read them the real times and ask again.`;
          } else {
            const spokenText = spoken.map(formatClock).join(', ');
            clog.warn(`[accept_slot] refused: caller said ${spokenText}, choice ${args.choice} is ambiguous`);
            return `The caller said ${spokenText} but that was ambiguous. The diary has only: ${state.quoted.map((quoted) => speakTime(quoted.start_time)).join('; ')}. Read them the real times and ask again.`;
          }
        }
        if (deps.hold) {
          const refused = await deps.hold(slot);
          if (refused) {
            clog.warn(`[accept_slot] hold refused: ${refused}`);
            state.quoted = state.quoted.filter((quoted) => quoted !== slot);
            return `${speakTime(slot.start_time)} was just taken by another caller. Apologise, then call find_slots again and offer what it returns.`;
          }
        }
        recordAccepted(state, slot);
        const held = `Held ${speakTime(slot.start_time)}.`;
        // The diary priced this slot against the plans it knew about. None of them
        // means the visit cannot be billed yet — and a caller with a second policy is
        // exactly the case, so ask for it rather than booking it to the wrong insurer.
        const payable = slot.payable_with ?? [];
        if (payable.length > 0 && !knownPlans(state).some((plan) => payable.includes(plan))) {
          return `${held} It cannot be billed to the plan we have for them. Ask whether they hold any other insurance policy, and take the insurer's name.`;
        }
        return `${held} Confirm it back once, in one sentence, and move on.`;
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
      description:
        'Which of the clinic\'s sites is closest to an address the caller gives you, and the soonest appointment there. Pass their words for the day too whenever they named one.',
      parameters: z.object({
        address: z.string().describe('The street address the caller named, door number and all'),
        specialty_id: z.string().optional().describe('Only rank sites that offer this'),
        when_phrase: z
          .string()
          .optional()
          .describe('Their words for when they want to come, e.g. "on Thursday" — leave out if they have not said'),
      }),
      execute: async (args) => {
        if (!catalogue) return 'Cannot check that from here. Take the request and let the clinic come back to them.';
        const address = real(args.address);
        if (address === undefined || address.split(/\s+/).length < 2) {
          return 'That is not an address. Ask them which street and number they are at before calling this again.';
        }
        const request = state.request;
        const specialty = resolve(
          catalogue,
          real(args.specialty_id) ?? request.specialty_id,
          (c, v) => specialtyByName(c, v)?.id,
        );
        const whenPhrase = real(args.when_phrase) ?? request.when_phrase;
        const window = whenPhrase
          ? resolveWhen(whenPhrase, now(), {
              closureDays: catalogue.calendar?.closure_days,
              maxSpanDays: catalogue.calendar?.max_span_days ?? undefined,
            })
          : null;

        // The geocode and the diary are two strangers to each other, and the caller is
        // listening to both: they go out together, and the day's slots cost nothing on
        // top of placing the address. A diary that fails still leaves the distances.
        const plans = knownPlanIds(catalogue, request.insurers);
        const geocode = deps.geocode ?? ((query: string) => geocodeMadrid(query));
        let diaryFailed = false;
        const [origin, availability] = await Promise.all([
          geocode(address),
          window && (specialty || request.provider_id)
            ? api
                .findAvailability({
                  date_from: window.date_from,
                  date_to: window.date_to,
                  provider_id: request.provider_id,
                  specialty_id: specialty,
                  patient_id: state.matched?.patient_id,
                  insurer: plans.length > 0 ? plans : undefined,
                })
                .catch((err: unknown) => {
                  clog.warn(`[nearest_site] diary: ${String(err)}`);
                  diaryFailed = true;
                  return null;
                })
            : null,
        ]);

        if (!origin) return 'Could not place that address. Ask which street and number they are at.';
        // The geocoder answers a street it half-recognised with a real address somewhere
        // else in the city, and a confident wrong coordinate ranks the sites wrongly.
        if (origin.partial) {
          return `That address only half-matched: the closest thing to it is ${origin.address}. Read that back and ask whether it is right before you rank anything.`;
        }
        const ranked = rankSites(catalogue, origin, { specialty_id: specialty });
        if (ranked.length === 0) return 'No site offers that. Say so plainly.';
        if (availability) deps.onAvailability?.(availability);

        const three = ranked.slice(0, 3);
        const list = three.map((s) => `${s.name} about ${s.km} km`).join(', ');
        const placed = origin.exact ? '' : ` That address only placed to the street, not the number, so say "about".`;
        const distances = `Straight-line from ${origin.address}: ${list}.${placed}`;

        // The nearest site is the answer only if they can be seen there: one that has
        // nobody free on the day they asked for is a closer wrong answer.
        // A day they asked for the afternoon of is not answered with nine in the morning.
        const wanted = window?.part_of_day;
        const open = (availability?.slots ?? []).filter((s) => !wanted || inPart(s.start_time, wanted));
        const soonest = three
          .map((site) => ({
            site,
            slot: open
              .filter((s) => s.location_id === site.location_id)
              .sort((a, b) => a.start_time.localeCompare(b.start_time))[0],
          }))
          .find((candidate) => candidate.slot !== undefined);

        if (!soonest?.slot) {
          // Three states the caller hears differently: the diary never answered, the
          // diary refused on a standing rule, and the diary is simply full.
          if (diaryFailed) {
            return `${distances} The diary did not answer, so nothing is known about that day — say you will check and call find_slots again.`;
          }
          const blocked = (availability?.blocked ?? []).map((entry) => entry.restriction).join('; ');
          if (blocked) {
            recordRequest(state, { blocked_by: blocked });
            clog.warn(`[nearest_site] blocked: ${blocked}`);
            return `${distances} Nothing bookable at any of them: ${blocked}. Tell the caller plainly and do not offer a time.`;
          }
          const nothing = window
            ? ` Nothing free at any of them then — offer to look at another day.`
            : ` Ask which day suits and call find_slots.`;
          return `${distances}${nothing}`;
        }
        if (state.request.blocked_by) retract(state, 'blocked_by');

        const slot = soonest.slot;
        recordRequest(state, { location_id: slot.location_id });
        recordQuote(state, [
          {
            provider_id: slot.provider_id,
            provider_name: slot.provider_name ?? undefined,
            location_id: slot.location_id,
            appointment_type_id: slot.appointment_type_id,
            start_time: slot.start_time,
            payable_with: slot.payable_with ?? undefined,
          },
        ]);
        return `${distances} The nearest that can see them is ${soonest.site.name}: ${speakTime(slot.start_time)} with ${slot.provider_name ?? slot.provider_id}. Offer that one and no other. When they say yes, call accept_slot.`;
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
            const hours = siteHours(catalogue, site.id, args.date);
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

  // One cap, applied once, so no tool can be written without one.
  type Executable = { execute: (args: never, ctx: never) => unknown };
  for (const [name, tool] of Object.entries(tools as Record<string, Executable>)) {
    const execute = tool.execute.bind(tool);
    tool.execute = async (args, ctx) => {
      const result = await capped(name, timeoutMs, execute(args, ctx));
      clog.info(`[tool ${name}] → ${String(result).slice(0, 300)}`);
      return result as never;
    };
  }
  return tools;
}

function siteName(catalogue: Catalogue | null, locationId: string): string {
  if (!catalogue) return locationId;
  return locationById(catalogue, locationId)?.name ?? locationId;
}

function clockForLog(startTime: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(startTime));
  return {
    hour: Number(parts.find((part) => part.type === 'hour')?.value ?? 0),
    minute: Number(parts.find((part) => part.type === 'minute')?.value ?? 0),
  };
}

function formatClock(time: { hour: number; minute: number }): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
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
