import { isSimUrl } from '@/lib/sim/client';

/**
 * Which world the console is looking at, decided by what the agent submits to
 * (its /health `clinic_api`), never by what happens to be running on this machine:
 * a sim on :8788 next to an agent on real Prosper is still live.
 */
export type ConsoleMode = 'live' | 'simulation' | 'mock' | 'unknown';

export function consoleMode(clinicApi: string | null): ConsoleMode {
  if (!clinicApi) return 'unknown';
  if (isSimUrl(clinicApi)) return 'simulation';
  if (/\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(clinicApi)) return 'mock';
  return 'live';
}

export const MODE_LABEL: Record<ConsoleMode, string> = {
  live: 'Live · Prosper',
  simulation: 'Simulation · shared clinic',
  mock: 'Local mock',
  unknown: 'Agent unreachable',
};
