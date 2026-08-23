import type { Aircraft } from './types';

const BASE = 'https://api.adsb.lol';

/** adsb.lol's raw row shape. Every field is optional in practice. */
interface RawAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;   // "ground" for surface aircraft
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  geom_rate?: number;
  category?: string;
  dst?: number;                 // nm from the query point, precomputed
  dir?: number;                 // bearing from the query point, precomputed
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Parse an adsb.lol /v2 response.
 *
 * Rows carry registration (`r`), ICAO type (`t`), and precomputed distance and
 * bearing (`dst`/`dir`) inline — which is why this source removes the per-flight
 * aircraft lookup entirely rather than just replacing the position feed.
 *
 * Never throws, at the payload level or the row level. A row with a
 * wrong-typed field (`t` arriving as a number, say) degrades just that field
 * to empty/null rather than losing the row or the request. That distinction
 * matters downstream: a thrown error fails the whole fetch, which the device
 * treats as "keep showing the last flights" — survivable. An empty list looks
 * like a successful fetch of an empty sky, which blanks the display instead.
 * One malformed row must not manufacture either outcome for every aircraft
 * riding along in the same response.
 */
export function parseAdsbLol(body: unknown): Aircraft[] {
  const rows = (body as { ac?: unknown })?.ac;
  if (!Array.isArray(rows)) return [];

  const out: Aircraft[] = [];
  for (const r of rows as RawAircraft[]) {
    const lat = num(r?.lat);
    const lon = num(r?.lon);
    if (lat === null || lon === null) continue;

    // alt_baro is the string "ground" for surface aircraft, not a number.
    //
    // The sentinel governs BOTH derived quantities, not just altitude. It used
    // to gate only altFt while verticalRateFpm read its identical fallback
    // chain ungated -- so a surface aircraft could carry a climb rate. Not
    // hypothetical: of the 74 "alt_baro":"ground" rows in the captured fixture,
    // 2 carry a rate, both adsr_icao rebroadcast rows (a recurring class, not a
    // one-off), and one of those has geom_rate surviving from the very GNSS
    // source whose alt_geom the ground gate had just discarded.
    //
    // ETA-neutral by construction: eta.ts returns early when altitudeFt is
    // null, which is always true here. Only the `vs` wire field changes.
    // firmware/adapters/AdsbLolFetcher.cpp carries an independent copy of this
    // parse and is gated the same way, so a device on the server path and one
    // on the direct path agree.
    const onGround = r.alt_baro === 'ground';
    const altFt = onGround ? null : num(r.alt_baro) ?? num(r.alt_geom);
    const verticalRateFpm = onGround ? null : num(r.baro_rate) ?? num(r.geom_rate);

    out.push({
      hex: str(r.hex).toLowerCase(),
      callsign: str(r.flight),
      registration: str(r.r) || null,
      typeIcao: str(r.t) || null,
      lat,
      lon,
      altFt,
      groundspeedKt: num(r.gs),
      trackDeg: num(r.track),
      verticalRateFpm,
      onGround,
      category: str(r.category) || null,
      distanceNm: num(r.dst),
      bearingDeg: num(r.dir),
    });
  }
  return out;
}

/** Fetch live aircraft within `radiusNm` of a point. Throws on transport failure. */
export async function fetchAircraft(lat: number, lon: number, radiusNm: number): Promise<Aircraft[]> {
  const url = `${BASE}/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${Math.round(radiusNm)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'flightwall-server/1.0 (+https://github.com/)' },
  });
  if (!res.ok) throw new Error(`adsb.lol ${res.status}`);
  return parseAdsbLol(await res.json());
}
