import { config } from './config.js';
import { describeError } from './errors.js';
import { ROUTES, type Action } from './schema.js';

/** Stateless, so shared; only the call_id varies. */

export interface SubmitResult {
  action: Action['action'];
  route: string;
  body: Record<string, unknown>;
  status: number;
  ok: boolean;
  response?: unknown;
  error?: string;
  attempts: number;
  durationMs: number;
}

/**
 * A call that does two things posts twice. Identical ones are collapsed first: models
 * repeat themselves when they are unsure, and the second POST comes back 409 "already
 * has that action" — a wasted round trip inside the 30 s close window.
 */
export async function submitActions(
  callId: string,
  actions: Action[],
  baseUrl: string = config.prosper.baseUrl,
): Promise<SubmitResult[]> {
  const results: SubmitResult[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(await submitOne(callId, action, baseUrl));
  }
  return results;
}

async function submitOne(callId: string, action: Action, baseUrl: string): Promise<SubmitResult> {
  const { action: verb, ...fields } = action;
  const route = ROUTES[verb];
  const url = `${baseUrl}/api/v1/submit/${route}`;
  const body: Record<string, unknown> = { call_id: callId, ...fields };
  const startedAt = Date.now();

  let attempts = 0;
  let lastError: string | undefined;

  // One retry on a network error or 5xx. 409 is a retry landing twice, not a failure;
  // 410 is the closed window, which a second attempt cannot pass.
  while (attempts < 2) {
    attempts++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.prosper.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }

      const retryable = res.status >= 500;
      if (retryable && attempts < 2) {
        lastError = `http ${res.status}`;
        continue;
      }

      return {
        action: verb,
        route,
        body,
        status: res.status,
        // 409 means an identical action already landed: the record we wanted.
        ok: res.status === 200 || res.status === 409,
        response: parsed,
        attempts,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      lastError = describeError(err);
      if (attempts >= 2) break;
    }
  }

  return {
    action: verb,
    route,
    body,
    status: 0,
    ok: false,
    error: lastError,
    attempts,
    durationMs: Date.now() - startedAt,
  };
}
