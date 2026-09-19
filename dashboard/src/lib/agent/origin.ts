export type AgentMode = 'live' | 'simulation';

const KEY = 'console.mode';

export function storedMode(): AgentMode {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'simulation' ? 'simulation' : 'live';
  } catch {
    return 'live';
  }
}

export function storeMode(mode: AgentMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Private windows may not persist local storage.
  }
}

export function agentOrigin(mode: AgentMode): string {
  if (!import.meta.env.PROD) return `/agents/${mode}`;
  const origin = mode === 'live' ? import.meta.env.VITE_AGENT_ORIGIN : import.meta.env.VITE_SIM_AGENT_ORIGIN;
  return origin ?? '';
}
