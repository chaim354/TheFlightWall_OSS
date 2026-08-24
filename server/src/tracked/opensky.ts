const BASE = 'https://opensky-network.org/api/states/all';

export interface OpenSkyPosition {
  lat: number;
  lon: number;
  altitudeFt: number | null;
  headingDeg: number | null;
  onGround: boolean;
  seenAtEpoch: number | null;
}

export type PositionResult =
  | { ok: true; position: OpenSkyPosition | null }
  | { ok: false; reason: string };

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const M_TO_FT = 3.280839895;

/**
 * Map an OpenSky /states/all body to one position, or null if nobody is
 * receiving that aircraft.
 *
 * OpenSky returns POSITIONAL ARRAYS, not objects, so every field here is an
 * index into an undocumented-by-shape tuple. The indices are from its API docs;
 * the test pins them with a realistic vector so a reordering upstream fails
 * loudly rather than silently swapping latitude and longitude.
 *
 * null is "not currently seen", which is the ocean-gap case and NOT an error --
 * the caller responds by dead-reckoning, so conflating it with a failure would
 * drop the card exactly when the estimate is most wanted.
 */
export function parseStates(body: unknown): OpenSkyPosition | null {
  const states = (body as { states?: unknown } | null)?.states;
  if (!Array.isArray(states) || states.length === 0) return null;
  const s = states[0];
  if (!Array.isArray(s)) return null;

  const lon = num(s[5]);
  const lat = num(s[6]);
  // A listed aircraft with no fix is common. Coercing null to 0 would place it
  // off the coast of Africa, which is the plausible-looking-wrong-value failure
  // this codebase already guards against elsewhere.
  if (lat === null || lon === null) return null;

  const altM = num(s[7]);
  return {
    lat,
    lon,
    altitudeFt: altM === null ? null : Math.round(altM * M_TO_FT),
    headingDeg: num(s[10]),
    onGround: s[8] === true,
    seenAtEpoch: num(s[3]),
  };
}

/**
 * One OpenSky lookup for a single transponder address.
 *
 * Filtering by icao24 rather than fetching an area is what keeps this cheap
 * enough to run per tick -- see the credit measurement in
 * docs/superpowers/audits/2026-08-24-tracked-flights-measurements.md.
 */
export async function fetchPosition(
  icao24: string,
  clientId: string,
  clientSecret: string,
): Promise<PositionResult> {
  const url = `${BASE}?icao24=${encodeURIComponent(icao24.toLowerCase())}`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  try {
    return { ok: true, position: parseStates(await res.json()) };
  } catch {
    return { ok: false, reason: 'unparseable response' };
  }
}
