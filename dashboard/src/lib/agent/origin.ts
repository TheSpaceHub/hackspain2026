export type AgentMode = 'live' | 'simulation';

const MODE_KEY = 'console.mode';
const ORIGIN_KEYS: Record<AgentMode, string> = {
  live: 'agent-origin.live',
  simulation: 'agent-origin.simulation',
};

export function storedMode(): AgentMode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return value === 'simulation' ? 'simulation' : 'live';
  } catch {
    return 'live';
  }
}

export function storeMode(mode: AgentMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private windows may not persist local storage.
  }
}

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

function storedOrigin(mode: AgentMode): string {
  try {
    return localStorage.getItem(ORIGIN_KEYS[mode]) ?? '';
  } catch {
    return '';
  }
}

function fallbackOrigin(mode: AgentMode): string {
  const configured = mode === 'live' ? import.meta.env.VITE_AGENT_ORIGIN : import.meta.env.VITE_SIM_AGENT_ORIGIN;
  return normalizeOrigin(configured ?? '');
}

function writeOrigin(mode: AgentMode, origin: string): void {
  try {
    localStorage.setItem(ORIGIN_KEYS[mode], origin);
  } catch {
    // Private windows may not persist local storage.
  }
}

function applyQueryOrigin(): void {
  if (!import.meta.env.PROD) return;
  const param = new URLSearchParams(window.location.search).get('agent');
  if (param !== null) writeOrigin(storedMode(), normalizeOrigin(param));
}

applyQueryOrigin();

/** HTTP base for the selected fixed-mode agent. */
export function agentOrigin(mode: AgentMode): string {
  if (!import.meta.env.PROD) return `/agents/${mode}`;
  return storedOrigin(mode) || fallbackOrigin(mode);
}

/** Whether a deployed console still needs an agent URL for this mode. */
export function needsAgentOrigin(mode: AgentMode): boolean {
  return import.meta.env.PROD && !agentOrigin(mode);
}

/** Point one deployed console mode at another agent and reload its streams. */
export function setAgentOrigin(mode: AgentMode, input: string): void {
  const origin = normalizeOrigin(input);
  writeOrigin(mode, origin);
  const url = new URL(window.location.href);
  url.searchParams.set('agent', origin);
  window.location.replace(url.toString());
}

/** The host shown in the per-mode connection control. */
export function agentHost(mode: AgentMode): string {
  const origin = agentOrigin(mode);
  return origin ? origin.replace(/^https?:\/\//, '') : window.location.host;
}
