/**
 * Opt-in: `SIM_HOLDS=1` with `PROSPER_API_BASE_URL` pointing at the local sim
 * (`pnpm sim`). Off — the default — nothing here runs and the agent talks to
 * Prosper exactly as before.
 *
 * On, two things happen. Every request carries the call's id (`X-Sim-Call-Id`), so
 * the sim hides the slots other live calls are holding while still showing this
 * call its own. And `accept_slot` asks the sim for a hold before telling the caller
 * the time is theirs: a refusal means another call got there first, and the model is
 * told to look again instead of promising a slot the diary will reject at submit.
 */
import { callContext } from './log.js';
import type { QuotedSlot } from './call-state.js';

export const simHoldsEnabled = process.env.SIM_HOLDS === '1';

/** A fetch that names the call. Used by ClinicApi when the sim is on. */
export function simFetch(base: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const callId = callContext.getStore();
    if (!callId) return base(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('X-Sim-Call-Id', callId);
    return base(input, { ...init, headers });
  };
}

export interface HoldRefusal {
  status: number;
  detail: string;
}

/**
 * Take the slot for this call. `null` is a hold (or the sim being unreachable, which
 * must never cost the caller the time — the diary decides at submit as before).
 */
export async function holdSlot(
  baseUrl: string,
  callId: string,
  slot: QuotedSlot,
  patientId: string | undefined,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<HoldRefusal | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/__sim/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sim-Call-Id': callId },
      body: JSON.stringify({
        call_id: callId,
        provider_id: slot.provider_id,
        location_id: slot.location_id,
        appointment_type_id: slot.appointment_type_id,
        start_time: slot.start_time,
        patient_id: patientId,
      }),
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
    return { status: res.status, detail: typeof body.detail === 'string' ? body.detail : `hold refused (${res.status})` };
  } catch {
    return null;
  }
}

/** The call is over: whatever it still holds and did not book goes back on the diary. */
export async function releaseHolds(
  baseUrl: string,
  callId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  try {
    await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/__sim/calls/${encodeURIComponent(callId)}/holds`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Holds expire on their own.
  }
}
