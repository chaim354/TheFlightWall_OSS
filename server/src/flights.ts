import { fetchAircraft } from './adsblol';
import { enrich } from './enrich';
import { callsignKey } from './join';
import { loadSchedule, isStale, lookupRows, lookupByCallsign } from './schedule/store';
import { KM_PER_NM } from './geo';
import type { Flight, ScheduleRow } from './types';

export interface Env {
  SCHEDULE: KVNamespace;
  BOARDS: string;
  AERODATABOX_KEY: string;
}

/** Hard ceiling on `max`, so a caller cannot ask us to serialise the whole sky. */
export const MAX_FLIGHTS_CEILING = 40;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * Parse an optional-looking-but-guarded numeric query param as NaN when the
 * param is absent or blank, instead of as `0`.
 *
 * `Number(null)` and `Number('')` both coerce to `0`, which is a legitimate
 * value for every param this guards -- a coordinate of 0 (null island), or an
 * altitude bound of 0 ft. Every caller below uses `Number.isFinite(...)` to
 * mean "the caller actually supplied this", so an absent param must parse to
 * something that check rejects. Without this, two different failures both
 * happened to hide behind the same coercion: a missing `lat`/`lon` silently
 * queried position data for (0, 0) instead of returning 400, and an absent
 * `max_alt_ft` silently became "reject every aircraft above 0 ft" -- i.e. an
 * always-on filter that empties every ordinary request's flight list, since
 * `max_alt_ft` is documented as optional and the common case omits it
 * entirely. `radius_km` and `max` below don't need this: they use `X || default`,
 * and `0`/NaN are both already falsy, so absence already falls through to
 * their default there.
 */
const parseNum = (raw: string | null): number => (raw === null || raw.trim() === '' ? NaN : Number(raw));

export async function handleFlights(url: URL, env: Env, nowMs: number): Promise<Response> {
  const q = url.searchParams;
  const lat = parseNum(q.get('lat'));
  const lon = parseNum(q.get('lon'));
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return json({ ok: false, error: 'bad lat', flights: [] }, 400);
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return json({ ok: false, error: 'bad lon', flights: [] }, 400);

  const radiusKm = clamp(Number(q.get('radius_km')) || 40, 1, 400);
  const max = clamp(Math.trunc(Number(q.get('max'))) || 8, 1, MAX_FLIGHTS_CEILING);
  const units = q.get('units') === 'metric' ? 'metric' : 'imperial';
  const excludeGround = q.get('exclude_ground') === '1';
  const minAlt = parseNum(q.get('min_alt_ft'));
  const maxAlt = parseNum(q.get('max_alt_ft'));
  const ts = Math.floor(nowMs / 1000);

  // A KV read failure degrades to "no routes", not to a failed request.
  const stored = await loadSchedule(env.SCHEDULE).catch(() => null);
  const stale = isStale(stored, nowMs);

  let aircraft;
  try {
    aircraft = await fetchAircraft(lat, lon, radiusKm / KM_PER_NM);
  } catch {
    // ok:false, NOT an empty success. The firmware keeps its previous flights
    // on ok:false and would blank the display on an empty list.
    return json({ ok: false, ts, stale, flights: [] });
  }

  const flights: Flight[] = [];
  for (const a of aircraft) {
    if (excludeGround && a.onGround) continue;
    if (a.altFt !== null && Number.isFinite(minAlt) && a.altFt < minAlt) continue;
    if (a.altFt !== null && Number.isFinite(maxAlt) && a.altFt > maxAlt) continue;

    let rows: ScheduleRow[] = [];
    if (stored) {
      // Exact-callsign candidates first: they also cover alphanumeric callsigns
      // like BAW2LJ, which have no derivable number and would otherwise be
      // unjoinable. Fall back to the number index for everything else.
      rows = lookupByCallsign(stored.index, a.callsign);
      if (rows.length === 0) {
        const key = callsignKey(a.callsign);
        if (key) rows = lookupRows(stored.index, key.number);
      }
    }

    const f = enrich(a, rows, { units, centerLat: lat, centerLon: lon });
    if (f) flights.push(f);
  }

  flights.sort((x, y) => x.dst - y.dst);
  return json({ ok: true, ts, stale, flights: flights.slice(0, max) });
}
