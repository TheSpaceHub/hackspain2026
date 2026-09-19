/**
 * Talking to the test lab. It is served by the local Prosper (pnpm mock), not by
 * the agent, because that is the process holding the world the cases were built
 * against; in dev Vite proxies /__testlab there.
 */
import type { Run, RunRequest, RunSummary, SuiteResponse } from './types';

const ORIGIN = import.meta.env.PROD ? (import.meta.env.VITE_TESTLAB_ORIGIN ?? '') : '';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${ORIGIN}${path}`, { signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export function fetchSuite(signal?: AbortSignal): Promise<SuiteResponse> {
  return getJson<SuiteResponse>('/__testlab', signal);
}

/** Rebuild the random asks. Same seed, same asks — that is the whole point of it. */
export async function regenerateSuite(req: { seed?: number; random?: number }): Promise<SuiteResponse> {
  const res = await fetch(`${ORIGIN}/__testlab/suite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const body = (await res.json()) as SuiteResponse & { detail?: string };
  if (!res.ok) throw new Error(body.detail ?? `POST /__testlab/suite → ${res.status}`);
  return body;
}

export async function fetchRuns(signal?: AbortSignal): Promise<RunSummary[]> {
  return (await getJson<{ runs: RunSummary[] }>('/__testlab/runs', signal)).runs;
}

export function fetchRun(id: string, signal?: AbortSignal): Promise<Run> {
  return getJson<Run>(`/__testlab/runs/${encodeURIComponent(id)}`, signal);
}

export async function startRun(req: RunRequest): Promise<Run> {
  const res = await fetch(`${ORIGIN}/__testlab/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const body = (await res.json()) as Run & { detail?: string };
  if (!res.ok) throw new Error(body.detail ?? `POST /__testlab/runs → ${res.status}`);
  return body;
}

export async function stopRun(id: string): Promise<Run> {
  const path = `/__testlab/runs/${encodeURIComponent(id)}/stop`;
  const res = await fetch(`${ORIGIN}${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return (await res.json()) as Run;
}

export interface RunHandlers {
  onProgress: (done: number, total: number) => void;
  onFinished: () => void;
}

/**
 * One line per call as it settles. The payloads are progress only — the results
 * themselves are re-read from the run, so a dropped stream costs nothing.
 */
export function subscribeToRun(runId: string, handlers: RunHandlers): () => void {
  const source = new EventSource(`${ORIGIN}/__testlab/runs/${encodeURIComponent(runId)}/events`);

  source.addEventListener('case_finished', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent<string>).data) as { done: number; total: number };
      handlers.onProgress(data.done, data.total);
    } catch {
      // A truncated frame: the next one carries the same counters.
    }
  });
  source.addEventListener('run_finished', () => {
    handlers.onFinished();
    source.close();
  });

  return () => source.close();
}
