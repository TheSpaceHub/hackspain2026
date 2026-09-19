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

/**
 * Degrees to kilometres, fixed once at the caller's latitude. Over a city the meridian
 * hardly moves, so the projection is flat and every site afterwards costs two
 * subtractions, two multiplications and a hypotenuse — no trigonometry per site, and
 * the error against the great circle is centimetres at these distances.
 */
export interface Metric {
  readonly kx: number;
  readonly ky: number;
}

/**
 * Kilometres per degree on the WGS84 ellipsoid, expanded around the given latitude —
 * the flattening matters over the 20 km that separates the sites, and a single mean
 * radius would put a site 30 m out.
 */
export function metricAt(latitude: number): Metric {
  const lat = radians(latitude);
  return {
    kx: 111.41513 * Math.cos(lat) - 0.09455 * Math.cos(3 * lat) + 0.00012 * Math.cos(5 * lat),
    ky: 111.13209 - 0.56605 * Math.cos(2 * lat) + 0.0012 * Math.cos(4 * lat),
  };
}

/** Straight-line kilometres under a metric already fixed at the origin. */
export function flatKm(metric: Metric, origin: Point, site: Point): number {
  const dx = (site.longitude - origin.longitude) * metric.kx;
  const dy = (site.latitude - origin.latitude) * metric.ky;
  return Math.sqrt(dx * dx + dy * dy);
}

export interface NearestSiteQuery {
  /** Only sites where this specialty is offered are eligible. */
  specialty_id?: string;
  /** Only sites where this provider works are eligible. */
  provider_id?: string;
}

/** Sites that can serve the request, nearest first. */
export function rankSites(catalogue: Catalogue, origin: Point, query: NearestSiteQuery = {}): RankedSite[] {
  const metric = metricAt(origin.latitude);
  return eligibleSites(catalogue, query)
    .filter((l): l is Location & Point => l.latitude != null && l.longitude != null)
    .map((l) => ({ location_id: l.id, name: l.name, km: round(flatKm(metric, origin, l)) }))
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
  apiKey?: string;
}

export interface Placed extends Point {
  /** What the geocoder thinks it placed, for reading back to the caller. */
  address: string;
  /** True when the door number itself was found, rather than the street or the district. */
  exact: boolean;
}

/**
 * A spoken street address to a coordinate. The one network hop here: ranking itself is
 * offline, so a geocode failure costs the distance answer and nothing else. Google when
 * a key is configured — it is the one that places a door number — and OpenStreetMap
 * otherwise, so a checkout without a key still answers.
 */
export async function geocodeMadrid(address: string, options: GeocodeOptions = {}): Promise<Placed | null> {
  const key = options.apiKey ?? process.env.GOOGLE_MAPS_API_KEY ?? '';
  return key === '' ? nominatim(address, options) : google(address, key, options);
}

/** Rooftop and interpolated are a door number; a street or a district centroid is not. */
const EXACT = new Set(['ROOFTOP', 'RANGE_INTERPOLATED']);

async function google(address: string, key: string, options: GeocodeOptions): Promise<Placed | null> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  // Madrid, and only Madrid: a bare street name exists in forty Spanish towns, and the
  // caller is ringing a clinic with three sites in one city.
  url.searchParams.set('components', 'country:ES|administrative_area:Comunidad de Madrid');
  url.searchParams.set('language', 'es');
  url.searchParams.set('key', key);
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 3_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      status?: string;
      results?: {
        formatted_address?: string;
        geometry?: { location?: { lat?: number; lng?: number }; location_type?: string };
      }[];
    };
    const hit = body.results?.[0];
    const at = hit?.geometry?.location;
    if (body.status !== 'OK' || at?.lat == null || at?.lng == null) return null;
    return {
      latitude: at.lat,
      longitude: at.lng,
      address: hit?.formatted_address ?? address,
      exact: EXACT.has(hit?.geometry?.location_type ?? ''),
    };
  } catch {
    return null;
  }
}

async function nominatim(address: string, options: GeocodeOptions): Promise<Placed | null> {
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
    const hits = (await res.json()) as { lat?: string; lon?: string; display_name?: string; type?: string }[];
    const hit = hits[0];
    if (!hit?.lat || !hit?.lon) return null;
    return {
      latitude: Number(hit.lat),
      longitude: Number(hit.lon),
      address: hit.display_name ?? address,
      exact: hit.type === 'house' || hit.type === 'building',
    };
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
