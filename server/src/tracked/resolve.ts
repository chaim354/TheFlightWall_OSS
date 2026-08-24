import type { LatLon, ResolvedFlight } from './types';

const API_HOST = 'aerodatabox.p.rapidapi.com';
const BASE = `https://${API_HOST}`;

export type ResolveResult =
  | { ok: true; flight: ResolvedFlight }
  | { ok: false; retryable: boolean; reason: string };

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** AeroDataBox writes "2026-09-14 18:00Z"; Date.parse wants the T. */
const epoch = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

const coord = (airport: unknown): LatLon | null => {
  const loc = (airport as { location?: unknown } | null)?.location as
    | { lat?: unknown; lon?: unknown }
    | undefined;
  const lat = num(loc?.lat);
  const lon = num(loc?.lon);
  return lat === null || lon === null ? null : { lat, lon };
};

/**
 * Map one by-number payload to a ResolvedFlight, or null if it holds no row.
 *
 * Returning a row whose `icao24` is null is NOT the same as returning null. The
 * first means "this flight exists, we just have no transponder address"; the
 * second means "no such flight that day". The caller reports them differently,
 * and the spec flags the missing-modeS case as an explicit risk to keep visible.
 */
export function parseByNumber(payload: unknown): ResolvedFlight | null {
  const rows = Array.isArray(payload) ? payload : [payload];
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || typeof row !== 'object') return null;

  const aircraft = (row.aircraft ?? {}) as Record<string, unknown>;
  const dep = (row.departure ?? {}) as Record<string, unknown>;
  const arr = (row.arrival ?? {}) as Record<string, unknown>;
  const depAirport = (dep.airport ?? null) as Record<string, unknown> | null;
  const arrAirport = (arr.airport ?? null) as Record<string, unknown> | null;

  const modeS = str(aircraft.modeS);

  return {
    // Lowercase: OpenSky's icao24 is lowercase hex and every comparison
    // downstream assumes it.
    icao24: modeS ? modeS.toLowerCase() : null,
    reg: str(aircraft.reg),
    origIata: str(depAirport?.iata),
    destIata: str(arrAirport?.iata),
    orig: coord(depAirport),
    dest: coord(arrAirport),
    schedDepEpoch: epoch((dep.scheduledTime as { utc?: unknown } | undefined)?.utc),
    schedArrEpoch: epoch((arr.scheduledTime as { utc?: unknown } | undefined)?.utc),
  };
}

/**
 * One AeroDataBox by-number lookup.
 *
 * `retryable` is the important half of the return. A 404 means the flight is
 * not operating that date -- retrying it can only ever waste calls, and on an
 * unauthenticated endpoint a retry loop against a permanent miss is exactly how
 * the quota drains. Transport failures (429, 5xx, thrown) are the opposite:
 * they say nothing about the flight and are worth another attempt.
 */
export async function resolveFlight(
  number: string,
  date: string,
  apiKey: string,
): Promise<ResolveResult> {
  const url = `${BASE}/flights/number/${encodeURIComponent(number)}/${encodeURIComponent(date)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': API_HOST } });
  } catch (e) {
    return { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 404) {
    return { ok: false, retryable: false, reason: `not operating ${date}` };
  }
  if (!res.ok) {
    return { ok: false, retryable: true, reason: `HTTP ${res.status}` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, retryable: false, reason: 'unparseable response' };
  }

  const flight = parseByNumber(payload);
  if (!flight) {
    return { ok: false, retryable: false, reason: `not operating ${date}` };
  }
  return { ok: true, flight };
}
