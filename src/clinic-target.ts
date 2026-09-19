/**
 * Which clinic new calls book into: the real board, or the shared local sim
 * (`pnpm sim`). One process knows both and can be switched between them at runtime
 * (`POST /mode` — the console's mode pill); a call keeps the clinic it started on.
 *
 * `SIM_HOLDS=1` (or `PROSPER_API_BASE_URL` pointing at the sim) makes simulation the
 * boot mode; otherwise the agent boots live, exactly as before.
 */
import { config } from './config.js';

export type ClinicMode = 'live' | 'simulation';

export interface ClinicTarget {
  mode: ClinicMode;
  baseUrl: string;
}

const DEFAULT_LIVE = 'https://hackspain.getprosperapp.com';
const DEFAULT_SIM = 'http://127.0.0.1:8788';

function isLocal(url: string): boolean {
  return /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
}

const envUrl = config.prosper.baseUrl;
const bootSim = process.env.SIM_HOLDS === '1' || (isLocal(envUrl) && envUrl.endsWith(':8788'));

/** The URL for each mode. The one the env named is kept; the other is the default. */
export const CLINIC_URLS: Readonly<Record<ClinicMode, string>> = {
  live: bootSim ? (process.env.PROSPER_LIVE_URL ?? DEFAULT_LIVE) : envUrl,
  simulation: bootSim ? envUrl : (process.env.SIM_URL ?? DEFAULT_SIM).replace(/\/+$/, ''),
};

let current: ClinicMode = bootSim ? 'simulation' : 'live';

export function clinicMode(): ClinicMode {
  return current;
}

export function clinicTarget(): ClinicTarget {
  return { mode: current, baseUrl: CLINIC_URLS[current] };
}

export function isClinicMode(value: unknown): value is ClinicMode {
  return value === 'live' || value === 'simulation';
}

export function setClinicMode(mode: ClinicMode): ClinicTarget {
  current = mode;
  return clinicTarget();
}
