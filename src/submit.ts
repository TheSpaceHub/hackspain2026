import { config } from './config.js';
import { ROUTES, type Action } from './schema.js';

/**
 * The submission client. Stateless, so it is shared — the only thing that varies
 * per call is the call_id, which is passed in.
 */

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
 * A call that does two things posts twice, to the route each thing belongs to.
 * v0 emits one action, but the array is here from day one so multi-action needs
 * no rewrite.
 */
export async function submitActions(callId: string, actions: Action[]): Promise<SubmitResult[]> {
  const results: SubmitResult[] = [];
  for (const action of actions) {
    results.push(await submitOne(callId, action));
  }
  return results;
}

async function submitOne(callId: string, action: Action): Promise<SubmitResult> {
  const { action: verb, ...fields } = action;
  const route = ROUTES[verb];
  const url = `${config.prosper.baseUrl}/api/v1/submit/${route}`;
  const body: Record<string, unknown> = { call_id: callId, ...fields };
  const startedAt = Date.now();

  let attempts = 0;
  let lastError: string | undefined;

  // One immediate retry on a network error or a 5xx, then give up.
  // 409 is a retry landing twice, not a failure. 410 is the closed window and a
  // second attempt cannot pass it, so it is never retried.
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
        // 200 is accepted; 409 means an identical action already landed, which
        // is the record we wanted either way.
        ok: res.status === 200 || res.status === 409,
        response: parsed,
        attempts,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      lastError = String(err);
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
