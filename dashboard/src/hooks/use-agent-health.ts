import { useEffect, useState } from 'react';
import { type AgentHealth, fetchHealth } from '@/lib/agent/stats';

/** The agent's /health, re-read each time the console (re)connects to it — the clinic API can change on a restart. */
export function useAgentHealth(connected: boolean): AgentHealth | null {
  const [health, setHealth] = useState<AgentHealth | null>(null);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then(setHealth)
      .catch(() => {});
    return () => controller.abort();
  }, [connected]);
  return health;
}
