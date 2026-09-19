/**
 * Where the agent is. In dev, nowhere in particular: Vite proxies every agent path, so
 * requests stay same-origin. A deployed console (Vercel) has no proxy and talks to the
 * agent's public URL directly — the same tunnel Prosper dials. That URL changes whenever
 * the tunnel restarts, so it is set at runtime, not baked into the build:
 *
 *   https://console.example/?agent=https://xyz.trycloudflare.com   (a link to share)
 *
 * It sticks in this browser until changed. VITE_AGENT_ORIGIN is only the fallback.
 */

const KEY = 'agent-origin';

/** Accepts what people paste: a bare host, https://…, or the wss://…/ws Prosper dials. */
export function normalizeOrigin(input: string): string {
  let url = input.trim();
  if (!url) return '';
  if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
  return url
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/\/+$/, '')
    .replace(/\/ws$/, '');
}

function initial(): string {
  if (!import.meta.env.PROD) return '';
  const param = new URLSearchParams(window.location.search).get('agent');
  if (param !== null) {
    const origin = normalizeOrigin(param);
    try {
      localStorage.setItem(KEY, origin);
    } catch {
      // private window: it holds for this visit only
    }
    return origin;
  }
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored;
  } catch {
    // unreadable storage: fall through to the build's default
  }
  return normalizeOrigin(import.meta.env.VITE_AGENT_ORIGIN ?? '');
}

/** '' in dev (same-origin through the proxy) or when a deployed console has none yet. */
export const AGENT_ORIGIN = initial();

/** A deployed console that does not know where its agent is yet. */
export const NEEDS_AGENT_ORIGIN = import.meta.env.PROD && !AGENT_ORIGIN;

/** Point the console at another agent. Reloads, so every open stream reconnects there. */
export function setAgentOrigin(input: string): void {
  const origin = normalizeOrigin(input);
  try {
    localStorage.setItem(KEY, origin);
  } catch {
    // private window: carry it in the URL instead
  }
  const url = new URL(window.location.href);
  url.searchParams.set('agent', origin);
  window.location.replace(url.toString());
}

/** The call socket of the agent this console reads — what the Test tab rings by default. */
export function agentSocketUrl(): string {
  return `${(AGENT_ORIGIN || window.location.origin).replace(/^http/, 'ws')}/ws`;
}

/** For display: the host alone. */
export function agentHost(): string {
  return AGENT_ORIGIN ? AGENT_ORIGIN.replace(/^https?:\/\//, '') : window.location.host;
}
