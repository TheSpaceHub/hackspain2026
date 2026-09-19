/**
 * The scratchpad, filled beside the call instead of inside it.
 *
 * Writing a detail down used to be a tool call, and on Workers AI a tool call is a
 * second full pass of the dialogue model before the caller hears anything — measured at
 * 2-4s on top of a turn that already cost that much, for a tool whose answer was
 * "Noted.". Nothing the caller hears depends on that write, so it belongs off the turn:
 * each finished exchange is handed to a small model here, and the agent speaks without
 * waiting for it. The cost of being late is bounded by `settle`, which the close waits
 * on before the decider reads the state.
 */

import { z } from 'zod';
import {
  contradictsMatch,
  callerNameMatchesPatient,
  recordPatientField,
  recordMatch,
  recordRequest,
  recordThirdParty,
  readCallState,
  retract,
  type CallState,
  type PatientField,
} from './call-state.js';
import { config } from './config.js';
import { clog } from './log.js';

const PATIENT_FIELDS = [
  'given_name', 'first_surname', 'second_surname', 'national_id',
  'date_of_birth', 'phone', 'email', 'insurer',
] as const;

/** Only what is worth a write. Everything else the decider re-reads off the transcript. */
const patchSchema = z.object({
  // Optional keys, not a record keyed by the field enum: zod wants every key of such a
  // record present, and a caller gives one detail at a time.
  patient: z
    .object({
      given_name: z.string().optional(),
      first_surname: z.string().optional(),
      second_surname: z.string().optional(),
      national_id: z.string().optional(),
      date_of_birth: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      insurer: z.string().optional(),
    })
    .optional(),
  /** A field the caller took back and has not replaced. */
  retracted: z.array(z.enum(PATIENT_FIELDS)).optional(),
  intent: z.enum(['book', 'reschedule', 'cancel', 'register', 'question']).optional(),
  complaint: z.string().optional(),
  specialty_id: z.string().optional(),
  provider_name: z.string().optional(),
  when_phrase: z.string().optional(),
  language: z.string().optional(),
  insurers: z.array(z.string()).optional(),
  caller_is_patient: z.boolean().optional(),
  caller_name: z.string().optional(),
  relationship: z.string().optional(),
});

export type ExtractedPatch = z.infer<typeof patchSchema>;

const SYSTEM_PROMPT = `You transcribe facts, you do not converse. A receptionist is on a call; you keep her notes.

Read the exchange and return JSON holding ONLY facts the caller stated in it. Say nothing else — no prose, no explanation, no code fence.

The notes you are shown are context, so you can tell new from old. Never copy a value out of them into your answer, and never answer with anything the receptionist said — only the caller's own words count.

Rules:
- Omit any key you did not hear. An empty object is the right answer for small talk.
- Never guess, never infer, never fill a gap with "unknown" or a placeholder. If it was not said, it is not there.
- Copy values as the caller said them; spelled-out letters and digits are normalised downstream, so pass "4 8 0 6 4 7 1 6 Y" through unchanged.
- Spanish names carry two surnames: "Josefa Dominguez Navarro" is given_name Josefa, first_surname Dominguez, second_surname Navarro. A caller who gives one surname has given one surname — leave second_surname out rather than completing the name for them.
- date_of_birth is ISO yyyy-mm-dd, and only when the caller gave a day, a month and a year that make a real date. "2001 19 19" is not one: leave it out so the receptionist asks again.
- caller_is_patient is false only when the caller says the appointment is for someone else; set relationship when they name it.
- retracted lists fields the caller corrected and has not yet replaced.
- when_phrase is the caller's own words for when they want to come ("Thursday morning"), never a date you computed.

Schema: {"patient":{"given_name","first_surname","second_surname","national_id","date_of_birth","phone","email","insurer"},"retracted":[],"intent":"book|reschedule|cancel|register|question","complaint","specialty_id","provider_name","when_phrase","language","insurers":[],"caller_is_patient":bool,"caller_name","relationship"}`;

/** Placeholders the small models reach for rather than leaving a key out. */
const PLACEHOLDERS = new Set(['unknown', 'n/a', 'na', 'none', 'null', 'undefined', '', 'not provided', 'not given']);
const RELATIONSHIPS = new Set([
  'mother', 'father', 'parent', 'son', 'daughter', 'child', 'wife', 'husband',
  'partner', 'spouse', 'carer', 'guardian', 'brother', 'sister', 'grandmother',
  'grandfather', 'friend', 'madre', 'padre', 'hijo', 'hija', 'esposo', 'esposa',
  'pareja', 'cuidador', 'tutor', 'hermano', 'hermana', 'abuelo', 'abuela',
]);

function real(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return PLACEHOLDERS.has(trimmed.toLowerCase()) ? undefined : trimmed || undefined;
}

function relationship(value: unknown): string | undefined {
  const valueReal = real(value);
  if (!valueReal) return undefined;
  const folded = valueReal.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return RELATIONSHIPS.has(folded) ? valueReal : undefined;
}

/** Injectable so the tests never touch the network. */
export type Complete = (system: string, user: string, signal: AbortSignal) => Promise<string>;

export interface ExtractorDeps {
  state: CallState;
  complete?: Complete;
  /** Per-extraction cap. Off the turn, so it is generous; nothing waits on it. */
  timeoutMs?: number;
  onError?: (message: string) => void;
}

export interface Extractor {
  /** A finished exchange. Returns once queued, never once extracted. */
  observe(userText: string, agentText?: string): void;
  /** Everything queued has been applied, or the wait ran out. Called at close. */
  settle(waitMs: number): Promise<void>;
}

export const DEFAULT_EXTRACT_TIMEOUT_MS = 8_000;

export function createExtractor(deps: ExtractorDeps): Extractor {
  const { state } = deps;
  const complete = deps.complete ?? workersAiComplete;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;
  const onError = deps.onError ?? ((message: string) => clog.error(`[extract] ${message}`));

  // Serial: two extractions in flight would race on the same fields, and the later
  // exchange must win. A slow one therefore holds the next, which is fine — the caller
  // is not waiting on either.
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;

  const run = async (userText: string, agentText?: string): Promise<void> => {
    const startedAt = Date.now();
    try {
      const user = [
        'What the notes already hold:',
        readCallState(state),
        '',
        'The exchange, newest speech last:',
        agentText ? `Receptionist: ${agentText}` : null,
        `Caller: ${userText}`,
      ]
        .filter((line) => line !== null)
        .join('\n');

      const raw = await complete(SYSTEM_PROMPT, user, AbortSignal.timeout(timeoutMs));
      const patch = parsePatch(raw);
      if (patch) applyPatch(state, patch, userText);
      else onError(`unparseable patch: ${raw.slice(0, 200)}`);
    } finally {
      const duration = Date.now() - startedAt;
      if (duration > 6_000) clog.warn(`[extract] slow: ${(duration / 1000).toFixed(1)}s`);
    }
  };

  return {
    observe(userText, agentText) {
      if (!userText.trim()) return;
      queued++;
      chain = chain.then(() =>
        run(userText, agentText).catch((err: unknown) => onError(String(err))),
      ).finally(() => {
        queued--;
      });
    },

    async settle(waitMs) {
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      const startedAt = Date.now();
      try {
        await Promise.race([
          chain,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, waitMs);
          }),
        ]);
        if (timedOut && queued > 0) {
          clog.warn(`[extract] settle: ${queued} exchanges still queued after ${Date.now() - startedAt}ms`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Models fence and preface their JSON; take the first balanced object. */
export function parsePatch(raw: string): ExtractedPatch | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const parsed = patchSchema.safeParse(
          JSON.parse(raw.slice(start, i + 1), (_key, value) => (value === null ? undefined : value)),
        );
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function tight(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const NUMBER_WORDS =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|cero|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil)\b/i;

const MONTH_NAMES =
  /january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre/i;

/** Fields a model completes from the shape of a Spanish name or a date rather than from speech. */
const MUST_BE_HEARD = new Set<PatientField>([
  'given_name',
  'first_surname',
  'second_surname',
  'date_of_birth',
  'national_id',
  'phone',
]);

/**
 * Was this actually said? A surname the caller never spoke and a date assembled out of
 * three numbers that do not make one are both worse than an empty field: the receptionist
 * asks again for what is missing, and never asks about what she has wrong.
 */
export function heardIt(field: PatientField, value: string, heard: string): boolean {
  if (!MUST_BE_HEARD.has(field)) return true;
  const hay = tight(heard);
  const saidDigits = heard.replace(/\D/g, '');

  // A number can be said in words ("six hundred, nine nine nine"), which leaves no
  // digits to check against — but a turn with no number in it at all did not carry one.
  if (/\d/.test(value) && saidDigits === '') return NUMBER_WORDS.test(heard);

  if (field === 'date_of_birth') {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (parts === null) return hay.includes(tight(value));
    const [, year, month, day] = parts;
    const said: string[] = heard.match(/\d+/g) ?? [];
    const has = (n: string): boolean => said.includes(n) || said.includes(String(Number(n)));
    return (
      has(year!) && has(day!) && (has(month!) || MONTH_NAMES.test(heard))
    );
  }

  const digits = value.replace(/\D/g, '');
  if (digits.length >= 4) return saidDigits.includes(digits);
  const spoken = tight(value);
  return spoken.length >= 2 && hay.includes(spoken);
}

/**
 * The patch is speech, so every value goes through the same normalizers a tool call
 * used to, and a repeat of something already on the notes is dropped rather than
 * re-journalled — the caller confirming their name three times is one fact.
 *
 * `heard` is the turn the patch came from; pass it and anything not in it is dropped.
 */
export function applyPatch(state: CallState, patch: ExtractedPatch, heard?: string): void {
  for (const field of PATIENT_FIELDS) {
    const value = real(patch.patient?.[field]);
    if (value === undefined) continue;
    if (heard !== undefined && !heardIt(field, value, heard)) {
      clog.warn(`[extract] dropped ${field} "${value}": not in what the caller said`);
      continue;
    }
    const before = state.patient[field];
    const result = recordPatientField(state, field, value);
    if (before === result.value) state.journal.pop();
  }

  const given = real(patch.patient?.given_name);
  const surname = real(patch.patient?.first_surname);
  if (
    state.caller_is_patient &&
    patch.caller_is_patient !== false &&
    contradictsMatch(state, given, surname)
  ) {
    const name = [given, surname, real(patch.patient?.second_surname)].filter(Boolean).join(' ');
    recordMatch(state, null, `phone match dropped: caller says they are ${name}`);
    state.phone_match_rejected = name;
  }

  for (const field of patch.retracted ?? []) {
    if (state.patient[field as PatientField] !== undefined) retract(state, field as PatientField);
  }

  const request = {
    intent: patch.intent,
    complaint: real(patch.complaint),
    specialty_id: real(patch.specialty_id),
    provider_name: real(patch.provider_name),
    when_phrase: real(patch.when_phrase),
    language: real(patch.language),
    insurers: patch.insurers
      ?.map(real)
      .filter((i): i is string => i !== undefined && /\p{L}/u.test(i)),
  };
  const changed = Object.fromEntries(
    Object.entries(request).filter(([key, value]) => {
      if (value === undefined) return false;
      return Array.isArray(value)
        ? value.length > 0
        : (state.request as Record<string, unknown>)[key] !== value;
    }),
  );
  if (Object.keys(changed).length > 0) recordRequest(state, changed);

  if (patch.caller_is_patient !== undefined) {
    const caller = { name: real(patch.caller_name), relationship: relationship(patch.relationship) };
    const unchanged =
      state.caller_is_patient === patch.caller_is_patient &&
      caller.name === undefined &&
      caller.relationship === undefined;
    if (!unchanged) {
      if (patch.caller_is_patient === false && (caller.relationship === undefined || callerNameMatchesPatient(state, caller.name))) {
        clog.warn('[extract] ignored caller_is_patient=false: no relationship / caller is the patient');
      } else {
        recordThirdParty(state, patch.caller_is_patient, caller);
      }
    }
  }
}

const workersAiComplete: Complete = async (system, user, signal) => {
  const res = await fetch(`${config.cloudflare.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.cloudflare.apiToken}`,
    },
    body: JSON.stringify({
      model: config.cloudflare.extractorModel,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? '';
};
