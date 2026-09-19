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
  recordPatientField,
  recordRequest,
  recordThirdParty,
  readCallState,
  retract,
  type CallState,
  type PatientField,
} from './call-state.js';
import { config } from './config.js';

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

Rules:
- Omit any key you did not hear. An empty object is the right answer for small talk.
- Never guess, never infer, never fill a gap with "unknown" or a placeholder. If it was not said, it is not there.
- Copy values as the caller said them; spelled-out letters and digits are normalised downstream, so pass "4 8 0 6 4 7 1 6 Y" through unchanged.
- Spanish names carry two surnames: "Josefa Dominguez Navarro" is given_name Josefa, first_surname Dominguez, second_surname Navarro.
- caller_is_patient is false only when the caller says the appointment is for someone else; set relationship when they name it.
- retracted lists fields the caller corrected and has not yet replaced.
- when_phrase is the caller's own words for when they want to come ("Thursday morning"), never a date you computed.

Schema: {"patient":{"given_name","first_surname","second_surname","national_id","date_of_birth","phone","email","insurer"},"retracted":[],"intent":"book|reschedule|cancel|register|question","complaint","specialty_id","provider_name","when_phrase","language","insurers":[],"caller_is_patient":bool,"caller_name","relationship"}`;

/** Placeholders the small models reach for rather than leaving a key out. */
const PLACEHOLDERS = new Set(['unknown', 'n/a', 'na', 'none', 'null', 'undefined', '', 'not provided', 'not given']);

function real(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return PLACEHOLDERS.has(trimmed.toLowerCase()) ? undefined : trimmed || undefined;
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
  const onError = deps.onError ?? ((message: string) => console.error(`[extract] ${message}`));

  // Serial: two extractions in flight would race on the same fields, and the later
  // exchange must win. A slow one therefore holds the next, which is fine — the caller
  // is not waiting on either.
  let chain: Promise<void> = Promise.resolve();

  const run = async (userText: string, agentText?: string): Promise<void> => {
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
    if (patch) applyPatch(state, patch);
  };

  return {
    observe(userText, agentText) {
      if (!userText.trim()) return;
      chain = chain.then(() =>
        run(userText, agentText).catch((err: unknown) => onError(String(err))),
      );
    },

    async settle(waitMs) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          chain,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
          }),
        ]);
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
        const parsed = patchSchema.safeParse(JSON.parse(raw.slice(start, i + 1)));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The patch is speech, so every value goes through the same normalizers a tool call
 * used to, and a repeat of something already on the notes is dropped rather than
 * re-journalled — the caller confirming their name three times is one fact.
 */
export function applyPatch(state: CallState, patch: ExtractedPatch): void {
  for (const field of PATIENT_FIELDS) {
    const value = real(patch.patient?.[field]);
    if (value === undefined) continue;
    const before = state.patient[field];
    const result = recordPatientField(state, field, value);
    if (before === result.value) state.journal.pop();
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
    insurers: patch.insurers?.map(real).filter((i): i is string => i !== undefined),
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
    const caller = { name: real(patch.caller_name), relationship: real(patch.relationship) };
    const unchanged =
      state.caller_is_patient === patch.caller_is_patient &&
      caller.name === undefined &&
      caller.relationship === undefined;
    if (!unchanged) recordThirdParty(state, patch.caller_is_patient, caller);
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
