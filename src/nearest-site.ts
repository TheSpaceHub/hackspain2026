/**
 * "Which of your clinics is closest to me?"
 *
 * Scored against published straight-line distance between the caller's address and the
 * five site coordinates, so it is arithmetic rather than something to be recalled. The
 * nearest site is only the right answer if it can actually serve the request, so the
 * candidates are filtered before they are ranked — a closer site that has nobody in the
 * specialty is the wrong answer.
 */

import type { Catalogue, Location } from './clinic-api.js';

export interface Point {
  latitude: number;
  longitude: number;
}

export interface RankedSite {
  location_id: string;
  name: string;
  km: number;
}

export interface NearestSiteQuery {
  /** Only sites where this specialty is offered are eligible. */
  specialty_id?: string;
  /** Only sites where this provider works are eligible. */
  provider_id?: string;
}

/** Sites that can serve the request, nearest first. */
export function rankSites(catalogue: Catalogue, origin: Point, query: NearestSiteQuery = {}): RankedSite[] {
  return eligibleSites(catalogue, query)
    .filter((l): l is Location & Point => l.latitude != null && l.longitude != null)
    .map((l) => ({ location_id: l.id, name: l.name, km: round(haversineKm(origin, l)) }))
    .sort((a, b) => a.km - b.km);
}

function eligibleSites(catalogue: Catalogue, query: NearestSiteQuery): Location[] {
  const providers = catalogue.providers.filter(
    (p) =>
      (query.specialty_id === undefined || p.specialty_id === query.specialty_id) &&
      (query.provider_id === undefined || p.id === query.provider_id),
  );
  if (query.specialty_id === undefined && query.provider_id === undefined) return catalogue.locations;

  const served = new Set(providers.flatMap((p) => p.location_names.map(fold)));
  return catalogue.locations.filter(
    (l) => served.has(fold(l.name)) || l.provider_names.some((n) => providers.some((p) => fold(p.name) === fold(n))),
  );
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: Point, b: Point): number {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export interface GeocodeOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  userAgent?: string;
}

/**
 * A spoken street address to a coordinate. The one network hop here: ranking itself is
 * offline, so a geocode failure costs the distance answer and nothing else.
 */
export async function geocodeMadrid(address: string, options: GeocodeOptions = {}): Promise<Point | null> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', `${address}, Madrid, Spain`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  try {
    const res = await doFetch(url, {
      headers: { 'User-Agent': options.userAgent ?? 'prosper-reception/1.0' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (!res.ok) return null;
    const hits = (await res.json()) as { lat?: string; lon?: string }[];
    const hit = hits[0];
    if (!hit?.lat || !hit?.lon) return null;
    return { latitude: Number(hit.lat), longitude: Number(hit.lon) };
  } catch {
    return null;
  }
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function round(km: number): number {
  return Math.round(km * 10) / 10;
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
