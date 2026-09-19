import { useEffect, useState } from 'react';
import { type AgentHealth, type AgentMode, fetchHealth } from '@/lib/agent/stats';

const POLL_MS = 3_000;

export interface AgentHealthState {
  health: AgentHealth | null;
}

/**
 * The selected agent's /health, re-read on (re)connect and every few seconds after.
 */
export function useAgentHealth(connected: boolean, mode: AgentMode): AgentHealthState {
  const [health, setHealth] = useState<AgentHealth | null>(null);

  useEffect(() => {
    if (!connected) {
      setHealth(null);
      return;
    }
    const controller = new AbortController();
    const read = (): void => {
      fetchHealth(mode, controller.signal)
        .then(setHealth)
        .catch(() => {
          if (!controller.signal.aborted) setHealth(null);
        });
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [connected, mode]);

  return { health };
}
