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
  releaseAccepted,
  recordMatch,
  recordQuote,
  appointmentKey,
  appointmentsMatching,
  callerSilentSinceQuote,
  callerAccepted,
  recordRequest,
  retract,
  saidTimes,
  sameClock,
  type CallState,
  type QuotedSlot,
  type UpcomingAppointment,
} from './call-state.js';
import { attachBrief, describeBrief } from './patient-brief.js';
import { geocodeMadrid, rankSites, type Placed } from './nearest-site.js';
import { addDays, madridDate, resolveWhen, type WhenWindow } from './when.js';
import { clog } from './log.js';
import { fold } from './fuzzy.js';

export interface ToolDeps {
  state: CallState;
  api: ClinicApi;
  catalogue: Catalogue | null;
  /** Kept so the decider can name the standing rule that refused a booking. */
  onAvailability?: (availability: Availability) => void;
  now?: () => Date;
  lastCallerText?: () => string | undefined;
  lastAgentOffer?: () => string | undefined;
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

function alternateSpecialtyLabel(name: string): string {
  if (name.toLowerCase() === 'dermatology') return 'dermatologist';
  return `${name.replace(/\b\w/g, (letter) => letter.toUpperCase())} doctor`;
}

function appointmentText(catalogue: Catalogue | null, appointment: UpcomingAppointment): string {
  return `${speakTime(appointment.start_time)} at ${siteName(catalogue, appointment.location_id ?? '')}`;
}

function clockMinutes(clock: { hour: number; minute: number }): number {
  return clock.hour * 60 + clock.minute;
}

function slotClock(startTime: string): { hour: number; minute: number } {
  return clockForLog(startTime);
}

function withdrawOpenQuote(state: CallState): boolean {
  if (state.accepted || state.quoted.length === 0) return false;
  for (const slot of state.quoted) {
    const key = `${slot.start_time}|${slot.provider_id}`;
    if (!state.declined.includes(key)) state.declined.push(key);
  }
  recordQuote(state, []);
  return true;
}

function hardWindowPhrase(window: { after_clock?: { hour: number; minute: number }; before_clock?: { hour: number; minute: number }; at_clock?: { hour: number; minute: number } }): string | undefined {
  if (window.at_clock) return `at ${formatClock(window.at_clock)}`;
  if (window.after_clock) return `after ${formatClock(window.after_clock)}`;
  if (window.before_clock) return `before ${formatClock(window.before_clock)}`;
  return undefined;
}

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

/**
 * The caller said the appointment is for someone else, and the only record we hold is
 * the phone owner's (Cristina rang for her child and was booked herself). Nothing may
 * be looked up or held until that patient is identified.
 */
export function forWhomUnknown(state: CallState): string | undefined {
  if (state.caller_is_patient) return undefined;
  if (state.matched && state.matched_by === 'lookup') return undefined;
  const who = state.caller?.relationship ?? 'someone else';
  const owner = state.matched
    ? ` ${[state.matched.given_name, state.matched.first_surname].filter(Boolean).join(' ')} is the owner of the phone, not the patient, so their record and age do not apply.`
    : '';
  return `The appointment is for the caller's ${who}, and that patient is not identified yet.${owner} Ask for the patient's full name and date of birth, call identify_patient with them, and only then check the diary.`;
}

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

/**
 * A doctor's name that is not one unmistakable match is never resolved here: the agent
 * asks the caller to spell it. The nearest surnames go along so it can offer them.
 */
function spellDoctor(
  state: CallState,
  catalogue: Catalogue,
  spoken: string,
  found: Catalogue['providers'],
  specialtyId?: string,
): string {
  const candidates = found.length > 0 ? found : providersByName(catalogue, spoken, true);
  const names = candidates.map((p) => `${p.name} (${p.specialty_name ?? 'unknown'})`).join(', ');
  const key = fold(spoken);
  if (!state.spelling_asked.includes(key)) {
    state.spelling_asked.push(key);
    return `"${spoken}" is not a clear match for one doctor${names ? `; it could be ${names}` : ''}. Ask the caller to spell the surname letter by letter and read it back, then look again. Do not pick one, and do not say we have no such doctor.`;
  }
  if (found.length > 1) {
    return `"${spoken}" still fits more than one doctor: ${names}. Do not ask for the spelling again — name them and ask which one the caller means.`;
  }
  // Spelled once already and still nobody: the clinic has no such doctor. Say so and
  // offer the real ones, rather than asking for the spelling a second time.
  const pool = catalogue.providers.filter((p) => specialtyId === undefined || p.specialty_id === specialtyId);
  const offer = (pool.length > 0 ? pool : catalogue.providers)
    .map((p) => `${p.name} (${p.specialty_name ?? 'unknown'}, ${p.location_names.join('/') || 'unknown site'})`)
    .join('; ');
  const dept = pool.length > 0 && specialtyId !== undefined ? pool[0]!.specialty_name ?? 'that department' : 'the clinic';
  return `The caller has already spelled "${spoken}" and it is nobody on the clinic's list${names ? ` (nearest: ${names})` : ''}. Do not ask them to spell it again. Tell them plainly there is no Dr ${spoken} at Clínica Arenal, name the doctors of ${dept} — ${offer} — and ask whether one of them will do. If they only want Dr ${spoken}, say you are sorry you cannot help with that and end the call; do not book anyone else.`;
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
        // Alberto's call: identified by phone, slot held, then the model looked him up
        // again with a garbled query, got "no record" and started registering him.
        if (state.matched && state.caller_is_patient) {
          const m = state.matched;
          return `Already identified: ${[m.given_name, m.first_surname, m.second_surname].filter(Boolean).join(' ')} (${m.patient_id}), from the number they are ringing from. They are not a new patient and there is nothing to register — carry on with what they want.`;
        }
        const query = {
          name: real(args.name),
          national_id: real(args.national_id) ? state.patient.national_id ?? args.national_id : undefined,
          date_of_birth: real(args.date_of_birth),
          phone: real(args.phone) ?? (state.caller_is_patient ? state.patient.phone : undefined),
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
        location_id: z
          .string()
          .optional()
          .describe('The site exactly as the caller said it, every word, even if it sounds garbled ("Adrenal Source", "Arnal sir"); the diary works out which site is meant'),
      }),
      execute: async (args) => {
        // The model says "general practice" and "Centro"; the diary takes
        // `general_practice` and `loc_centro`, and rejects the whole query otherwise. A
        // filter we cannot resolve is dropped rather than sent: a wider search still
        // answers the caller, a 422 does not.
        const forSomeoneElse = forWhomUnknown(state);
        if (forSomeoneElse) return forSomeoneElse;
        if (state.accepted) {
          const a = state.accepted;
          const who = catalogue?.providers.find((p) => p.id === a.provider_id)?.name ?? a.provider_id;
          return `A slot is already held for this caller: ${speakTime(a.start_time)} with ${who} at ${siteName(catalogue, a.location_id)}. Do not look again or offer anything else. If they are unsure, confirm that one back in one sentence; if they say it is wrong, call release_slot first.`;
        }
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
        let namedProvider: Catalogue['providers'][number] | undefined;
        if (args.provider_name && catalogue) {
          const found = providersByName(catalogue, args.provider_name);
          if (found.length !== 1) return spellDoctor(state, catalogue, args.provider_name, found, specialty);
          if (found.length === 1) {
            namedProvider = found[0]!;
            providerId = namedProvider.id;
            recordRequest(state, { provider_id: providerId });
            // A doctor has one department; the diary answers `no matching provider` to
            // any other, so the doctor's own department is the one we ask for.
            const own = namedProvider.specialty_id ?? undefined;
            if (own && specialty && own !== specialty) {
              specialtyNote = ` Note: ${namedProvider.name} works in ${namedProvider.specialty_name ?? own}, not ${specialty}; tell the caller if that is not what they expected.`;
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

        const laterThanAppointment = (state.request.intent === 'reschedule' || state.request.appointment_id !== undefined) &&
          /\b(?:later than|after (?:my|the|that) (?:current|existing)?\s*appointment|the one i (?:have|already have)|m[aá]s tarde que|despu[eé]s de mi cita)\b/i.test(args.when_phrase);
        let window: WhenWindow = resolveWhen(args.when_phrase, now(), {
          locationId: location,
          closureDays: catalogue?.calendar?.closure_days,
          maxSpanDays: catalogue?.calendar?.max_span_days ?? undefined,
        });
        if (laterThanAppointment) {
          const selected = state.upcoming.find((appointment) =>
            appointment.appointment_id === state.request.appointment_id,
          );
          if (selected) {
            const selectedDate = madridDate(new Date(selected.start_time));
            const [year, month, day] = selectedDate.split('-').map(Number) as [number, number, number];
            const monthName = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
              new Date(Date.UTC(year, month - 1, day)),
            );
            window = resolveWhen(`after ${day} ${monthName}`, now(), {
              locationId: location,
              closureDays: catalogue?.calendar?.closure_days,
              maxSpanDays: catalogue?.calendar?.max_span_days ?? undefined,
            });
            window = { ...window, date_from: window.date_from || addDays(selectedDate, 1), earliest: true };
          }
        }
        if (window.part_of_day) recordRequest(state, { part_of_day: window.part_of_day });

        let availability = await api.findAvailability({
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

        let restrictionNote = '';
        const providerRestriction = namedProvider && providerId && availability.slots.length === 0
          ? availability.blocked.find((entry) =>
            (entry.provider_id === providerId || /provider_not_(?:in_network|found)/i.test(entry.restriction)) &&
            /provider_not_|does not (?:accept|take)|not in network/i.test(entry.restriction),
          )
          : undefined;
        if (providerRestriction && namedProvider) {
          const fallbackSpecialty = namedProvider.specialty_id ?? specialty;
          const fallback = await api.findAvailability({
            date_from: window.date_from,
            date_to: window.date_to,
            specialty_id: fallbackSpecialty,
            location_id: location,
            patient_id: state.matched?.patient_id,
            insurer: plans.length > 0 ? plans : undefined,
          });
          deps.onAvailability?.(fallback);
          if (fallback.slots.length > 0) {
            availability = fallback;
            specialty = fallbackSpecialty;
            restrictionNote = `${namedProvider.name} is not available with ${plans.join(', ') || 'that plan'}. `;
          } else {
            const blocked = availability.blocked.map((entry) => entry.restriction).join('; ');
            if (blocked) {
              recordRequest(state, { blocked_by: blocked });
              clog.warn(`[find_slots] blocked: ${blocked}`);
            }
            const withdrew = withdrawOpenQuote(state);
            return `Nothing bookable: ${blocked || providerRestriction.restriction}. Tell the caller plainly and do not offer a time.${withdrew ? ' The earlier offer is withdrawn — if they want it after all, call find_slots for that day again.' : ''}${specialtyNote}`;
          }
        }

        if (availability.slots.length === 0) {
          const blocked = availability.blocked.map((entry) => entry.restriction).join('; ');
          if (blocked) {
            recordRequest(state, { blocked_by: blocked });
            clog.warn(`[find_slots] blocked: ${blocked}`);
          }
          const withdrew = withdrawOpenQuote(state);
          const hardPhrase = hardWindowPhrase(window);
          const hardDate = !hardPhrase && /\b(?:after|from|a partir del|a partir de)\b/i.test(args.when_phrase);
          if (hardPhrase || hardDate) {
            const specialtyLabel = specialty ?? 'that specialty';
            const locationLabel = location ? ` at ${siteName(catalogue, location)}` : '';
            const constraint = hardPhrase ?? `after ${args.when_phrase.replace(/^.*?\b(?:after|from|a partir del|a partir de)\b\s*/i, '')}`;
            return `Nothing ${constraint} for ${specialtyLabel}${locationLabel} in that window. Tell the caller plainly and ask whether another day, another site, or a different time would do. Do not offer any other time.${withdrew ? ' The earlier offer is withdrawn — if they want it after all, call find_slots for that day again.' : ''}`;
          }
          return (blocked
            ? `Nothing bookable: ${blocked}. Tell the caller plainly and do not offer a time.`
            : 'Nothing free in that window. Offer to look at a different day.') +
            (withdrew ? ' The earlier offer is withdrawn — if they want it after all, call find_slots for that day again.' : '') +
            specialtyNote;
        }

        if (state.request.blocked_by) retract(state, 'blocked_by');
        if (!state.accepted) {
          for (const slot of state.quoted) {
            const key = appointmentKey(slot);
            if (!state.declined.includes(key)) state.declined.push(key);
          }
        }
        const declined = new Set(state.declined);
        availability = {
          ...availability,
          slots: availability.slots.filter((slot) => !declined.has(`${slot.start_time}|${slot.provider_id}`)),
        };
        if (availability.slots.length === 0) {
          const withdrew = withdrawOpenQuote(state);
          return `Nothing free in that window. Offer to look at a different day.${withdrew ? ' The earlier offer is withdrawn — if they want it after all, call find_slots for that day again.' : ''}${specialtyNote}`;
        }
        const wanted = window.part_of_day;
        const hardClock = hardWindowPhrase(window);
        const hardDate = !hardClock && /\b(?:after|from|a partir del|a partir de)\b/i.test(args.when_phrase);
        const matching = availability.slots.filter((slot) => {
          const inRequestedPart = wanted ? inPart(slot.start_time, wanted) : true;
          if (!inRequestedPart) return false;
          if (!hardClock) return true;
          const actual = clockMinutes(slotClock(slot.start_time));
          if (window.after_clock && actual < clockMinutes(window.after_clock)) return false;
          if (window.before_clock && actual > clockMinutes(window.before_clock)) return false;
          if (window.at_clock && actual !== clockMinutes(window.at_clock)) return false;
          return true;
        });
        if ((hardClock || hardDate) && matching.length === 0) {
          const constraint = hardClock ?? `after ${args.when_phrase.replace(/^.*?\b(?:after|from|a partir del|a partir de)\b\s*/i, '')}`;
          const specialtyLabel = specialty ?? 'that specialty';
          const locationLabel = location ? ` at ${siteName(catalogue, location)}` : '';
          const withdrew = withdrawOpenQuote(state);
          return `Nothing ${constraint} for ${specialtyLabel}${locationLabel} in that window. Tell the caller plainly and ask whether another day, another site, or a different time would do. Do not offer any other time.${withdrew ? ' The earlier offer is withdrawn — if they want it after all, call find_slots for that day again.' : ''}`;
        }
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
          for_patient_id: state.matched?.patient_id,
          payable_with: s.payable_with ?? undefined,
        }));
        recordQuote(state, quoted);
        state.invented_offer = undefined;
        state.invented_provider = undefined;

        const moved = window.adjusted_from ? `The day they asked for is closed, so this is from ${window.adjusted_from}. ` : '';
        const partNote = elsewhere ? `Nothing in the ${wanted} that day, so say so before you offer these. ` : '';
        // The warning is a sentence the model forgets two turns later; the half of the
        // day rides on each time instead, so a slot read back out is still labelled.
        const lines = quoted.map((s, i) => {
          const half = elsewhere ? ` (${inPart(s.start_time, 'morning') ? 'morning' : 'afternoon'})` : '';
          return `${i + 1}. ${speakTime(s.start_time)}${half} with ${s.provider_name ?? s.provider_id} at ${siteName(catalogue, s.location_id)}`;
        });
        const soonestIntro = restrictionNote
          ? `The soonest with another ${alternateSpecialtyLabel(namedProvider?.specialty_name ?? specialty ?? 'doctor')} is:`
          : 'The soonest there is:';
        return restrictionNote + (window.earliest
          ? `${moved}${partNote}${soonestIntro} ${lines[0]}. Offer that one and no other. When they say yes, call accept_slot. Only if they turn it down, ask which day would suit and look again.`
          : `${moved}${partNote}Offer these, and nothing else: ${lines.join('; ')}. When they pick one, call accept_slot.`) + specialtyNote;
      },
    }),

    accept_slot: llm.tool({
      description: 'The caller said yes to one of the times find_slots returned. Call it straight away, before anything else.',
      // The model sends "3" as often as 3, and a rejected call is a silent turn.
      parameters: z.object({ choice: z.coerce.number().int().describe('1, 2 or 3 as you read them out') }),
      execute: async (args) => {
        const forSomeoneElse = forWhomUnknown(state);
        if (forSomeoneElse) return forSomeoneElse;
        let slot = state.quoted[args.choice - 1];
        if (!slot) return 'That is not one of the times you offered. Read the list again or call find_slots.';
        if (state.matched && slot.for_patient_id !== state.matched.patient_id) {
          clog.warn('[accept_slot] refused: slot was quoted before the patient was identified');
          return 'That time was looked up before we knew who the patient is, so the appointment type may be wrong — call find_slots again now and offer what it returns.';
        }
        if (!state.quoted_spoken) {
          clog.warn('[accept_slot] refused: the quoted time was not spoken');
          return 'You have not read that time to the caller yet — offer it first (day and time), then wait for their answer.';
        }
        const offerText = deps.lastAgentOffer?.();
        const offered = offerText ? saidTimes(offerText) : [];
        if (
          offered.length > 0 &&
          !offered.some((said) => state.quoted.some((quoted) => sameClock(quoted, said)))
        ) {
          clog.warn(`[accept_slot] refused: agent offered ${offered.map(formatClock).join(', ')}, which was never quoted`);
          return `You told the caller ${offered.map(formatClock).join(', ')}, but no diary search returned that time — nothing is held. Call find_slots for the day they asked and offer only what it returns.`;
        }
        if (callerSilentSinceQuote(state)) {
          clog.warn(`[accept_slot] refused: caller has not spoken since the quote`);
          return 'The caller has not answered yet — nothing has been accepted. Do not hold anything; ask again whether that time suits and wait for their answer.';
        }
        const callerText = deps.lastCallerText?.();
        const callerDecision = callerText ? callerAccepted(callerText) : 'unclear';
        const spoken = callerText ? saidTimes(callerText) : [];
        if (callerDecision === 'no' || (spoken.length === 0 && callerDecision !== 'yes')) {
          const offered = speakTime(slot.start_time);
          clog.warn(`[accept_slot] refused: caller did not clearly accept ${offered}`);
          return `The caller has not clearly accepted that time — ask plainly whether ${offered} suits and wait for a yes.`;
        }
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
        state.invented_offer = undefined;
        state.invented_provider = undefined;
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

    release_slot: llm.tool({
      description:
        'Let go of the slot currently held, because the caller has changed their mind or said it is wrong. Only then may find_slots be called again.',
      parameters: z.object({}),
      execute: async () => {
        if (!state.accepted) return 'Nothing is held.';
        const was = speakTime(state.accepted.start_time);
        releaseAccepted(state, 'caller declined it');
        return `Released ${was}. Ask what would suit instead, then call find_slots.`;
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
        state.upcoming = appointments.map((appointment) => ({
          appointment_id: appointment.appointment_id,
          start_time: appointment.start_time,
          location_id: appointment.location_id ?? undefined,
          provider_id: appointment.provider_id ?? undefined,
        }));
        state.appointment_ids = [];
        state.appointment_picked_by = undefined;
        if (appointments.length === 1) {
          state.appointment_picked_by = 'only_one';
          state.appointment_ids = [appointments[0]!.appointment_id];
          recordRequest(state, { appointment_id: appointments[0]!.appointment_id });
          return `${appointmentText(catalogue, state.upcoming[0]!)}.`;
        }
        retract(state, 'appointment_id');
        const numbered = state.upcoming
          .map((appointment, index) => `${index + 1}. ${appointmentText(catalogue, appointment)}`)
          .join('; ');
        return `${numbered}. Ask which one they mean, then call pick_appointment with their words.`;
      },
    }),
    pick_appointment: llm.tool({
      description: 'Choose one of the patient appointments from the caller\'s own words before moving or cancelling it.',
      parameters: z.object({ said: z.string().describe('The caller\'s words for the appointment, such as "Thursday 8 October" or "the 10:45 one"') }),
      execute: async (args) => {
        if (state.upcoming.length === 0) return 'Call list_appointments first.';
        const matches = appointmentsMatching(state.upcoming, args.said, now());
        if (matches.length === state.upcoming.length && state.upcoming.length > 1) {
          state.appointment_ids = matches.map((appointment) => appointment.appointment_id);
          state.appointment_picked_by = 'caller';
          recordRequest(state, { appointment_id: matches[0]!.appointment_id });
          return `That is all of them: ${matches.map((appointment) => appointmentText(catalogue, appointment)).join('; ')}. Confirm each one before cancelling.`;
        }
        if (matches.length !== 1) {
          const remaining = state.upcoming
            .map((appointment, index) => `${index + 1}. ${appointmentText(catalogue, appointment)}`)
            .join('; ');
          return `${matches.length === 0 ? 'I could not match that to one appointment' : 'That still matches more than one appointment'}: ${remaining}. Ask which one they mean and call pick_appointment with their words.`;
        }
        const picked = matches[0]!;
        state.appointment_picked_by = 'caller';
        if (!state.appointment_ids.includes(picked.appointment_id)) state.appointment_ids.push(picked.appointment_id);
        recordRequest(state, { appointment_id: picked.appointment_id });
        const index = state.upcoming.indexOf(picked) + 1;
        return `That is ${index}. ${appointmentText(catalogue, picked)}. Confirm it back before cancelling or moving.`;
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
          if (found.length !== 1) return spellDoctor(state, catalogue, args.doctor_name, found, state.request.specialty_id);
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

export function siteName(catalogue: Catalogue | null, locationId: string): string {
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
