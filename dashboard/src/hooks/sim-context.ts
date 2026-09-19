import { createContext, useContext } from 'react';
import type { SimFeed } from './use-sim-feed';

export interface SimContextValue {
  sim: SimFeed;
  /** Open the clinic on a day (YYYY-MM-DD). */
  openClinic: (date: string) => void;
}

/**
 * The shared clinic, reachable from any call panel without threading it through
 * every view: a call's holds and bookings are drawn next to its transcript.
 */
export const SimContext = createContext<SimContextValue | null>(null);

export function useSim(): SimContextValue | null {
  return useContext(SimContext);
}
