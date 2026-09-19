import { useCallback, useEffect, useState } from 'react';
import { type AgentHealth, type AgentMode, fetchHealth, setAgentMode } from '@/lib/agent/stats';

const POLL_MS = 3_000;

export interface AgentHealthState {
  health: AgentHealth | null;
  /** Switch the agent's clinic. Resolves to the health it reports afterwards. */
  setMode: (mode: AgentMode) => Promise<void>;
  switching: boolean;
}

/**
 * The agent's /health, re-read on (re)connect and every few seconds after — the mode
 * can be switched from any console tab, or the agent restarted on another clinic.
 */
export function useAgentHealth(connected: boolean): AgentHealthState {
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    const read = (): void => {
      fetchHealth(controller.signal)
        .then(setHealth)
        .catch(() => {});
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [connected]);

  const setMode = useCallback(async (mode: AgentMode) => {
    setSwitching(true);
    try {
      setHealth(await setAgentMode(mode));
    } finally {
      setSwitching(false);
    }
  }, []);

  return { health, setMode, switching };
}
