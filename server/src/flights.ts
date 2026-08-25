import { fetchAircraft } from './adsblol';
import { enrich } from './enrich';
import { resolveGatedRoute } from './routes/routeLookup';
import { callsignKey } from './join';
import { loadSchedule, isStale, lookupRows, lookupByCallsign, type ScheduleStorage } from './schedule/store';
import { KM_PER_NM } from './geo';
import { trackedCards } from './tracked/serve';
import type { TrackedStorage } from './tracked/store';
import type { Flight, ScheduleRow } from './types';

/**
 * Shared by both entry points. SCHEDULE is the storage abstraction (Task 1),
 * not a Workers KVNamespace directly -- index.ts adapts its real KV binding
 * with kvStorage(), server.ts adapts a JSON file with fileStorage(), and
 * this function never knows the difference.
 */
export interface Env {
  SCHEDULE: ScheduleStorage;
  /** Optional: absent on the Worker, which has no tracked-flight store. */
  TRACKED?: TrackedStorage;
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
  } catch (err) {
    // Log before swallowing. A bare `catch {}` here made a live failure
    // undiagnosable: the Worker returned ok:false with outcome "ok" and no
    // exception, so `wrangler tail` showed a healthy request and nothing else.
    console.error('position fetch failed:', err instanceof Error ? err.message : String(err));
    // ok:false, NOT an empty success. The firmware keeps its previous flights
    // on ok:false and would blank the display on an empty list.
    return json({ ok: false, ts, stale, flights: [] });
  }

  // Aircraft kept alongside its rendered Flight: the route fallback below needs
  // the aircraft's POSITION to run its corridor gate, and Flight carries only
  // distance/bearing relative to the query centre, not a latitude/longitude.
  const pairs: { a: (typeof aircraft)[number]; f: Flight }[] = [];
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

    const f = enrich(a, rows, { center: { lat, lon } }, nowMs);
    if (f) pairs.push({ a, f });
  }

  pairs.sort((x, y) => x.f.dst - y.f.dst);
  const top = pairs.slice(0, max);

  // Last-resort route fill, AFTER the slice on purpose. Only the flights that
  // will actually be returned are looked up -- at most `max` (8) callsigns per
  // request rather than one per aircraft in radius, which at a 200km radius is
  // the difference between 8 lookups and 60. Everything else about this is in
  // routeLookup.ts, including why a 32%-wrong source is safe behind the gate.
  await fillMissingRoutes(top, nowMs);

  const flights = top.map((p) => p.f);

  // Pinned first, ahead of the nearest-first area ordering. The cap is applied
  // AFTER prepending so a tracked flight can never be pushed off the end by
  // ordinary traffic -- being crowded out by a jet that happens to be closer is
  // exactly the failure this feature exists to prevent.
  const pinned = env.TRACKED ? trackedCards(await env.TRACKED.read(), nowMs, { lat, lon }) : [];
  const merged = [...pinned, ...flights].slice(0, max);

  return json({ ok: true, ts, stale, flights: merged });
}

/**
 * Fill origin/destination for flights the schedule table could not route.
 *
 * Only ever ADDS a route to a flight that had none -- a schedule match is
 * strictly better information (it is keyed on the actual leg, and it carries
 * arrival times these sources do not have) and is never overwritten.
 *
 * The ETA is deliberately left alone. adsbdb and hexdb supply no arrival time,
 * so a flight routed here keeps whatever enrich() already decided, which for a
 * previously-routeless flight is the physics estimate. Showing a route without
 * a schedule-derived ETA is honest; inventing one from a route would not be.
 *
 * Never throws: one unreachable third-party service must not fail the request
 * that was otherwise ready to return.
 */
async function fillMissingRoutes(
  pairs: readonly { a: { lat: number; lon: number; callsign: string }; f: Flight }[],
  nowMs: number,
): Promise<void> {
  // No callsign check: enrich() returns null for an empty one, so every pair
  // here already has a non-empty callsign by construction.
  const missing = pairs.filter((p) => !p.f.from && !p.f.to);
  if (missing.length === 0) return;

  await Promise.all(
    missing.map(async (p) => {
      try {
        const fix = await resolveGatedRoute(p.a.callsign, p.a.lat, p.a.lon, nowMs);
        if (!fix) return;
        p.f.from = fix.origIata;
        p.f.to = fix.destIata;
        // The identity fields, from the SAME reply -- no extra call.
        //
        // Every aircraft reaching here failed the schedule table, so flt and al
        // are null for all of them by construction. That is not a rare corner:
        // a callsign ending in a letter cannot reach matchSchedule's second
        // path at all, because callsignKey rejects it, so unless AeroDataBox
        // shipped the exact operating callsign there is no row and never will
        // be. UBT70A (Norse Atlantic UK) rendered with a route and no airline
        // for exactly this reason, while the reply that gave it LGW->JFK also
        // carried "Z070A" and "Norse Atlantic UK" and both were dropped.
        //
        // Guarded on null rather than assigned outright: a schedule row is the
        // MARKETING carrier and stays authoritative where one exists. hexdb
        // supplies neither field, so its fixes leave both alone.
        if (!p.f.flt && fix.flightIata) p.f.flt = fix.flightIata;
        if (!p.f.al && fix.airlineName) p.f.al = fix.airlineName;
      } catch {
        // resolveGatedRoute already swallows transport failures; this is the
        // belt-and-braces case (an unexpected throw from parsing or the cache),
        // and one flight failing to gain a route is not a failed request.
      }
    }),
  );
}
