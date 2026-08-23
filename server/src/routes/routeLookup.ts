import { getAirportCoord } from '../schedule/airports';
import { corridorExcessKm } from '../geo';
import { MAX_CORRIDOR_EXCESS_KM } from '../join';

/**
 * Callsign -> route, from adsbdb and hexdb, for flights the schedule table
 * missed.
 *
 * WHY THIS IS SAFE HERE AND WAS NOT SAFE ON THE DEVICE. These are
 * callsign-keyed route databases: they map a callsign STRING to a route
 * somebody once flew under it. That is a genuinely unreliable key -- measured
 * at ~32% wrong on live traffic, because a callsign is reused across days and
 * legs while the database answers with one fixed route. The firmware used to
 * consult them directly and had no way to tell a right answer from a wrong
 * one, which is why they were dropped.
 *
 * What changed is not the data, it is that there is now something to check it
 * AGAINST. `gateRoute` below rejects any answer whose corridor the aircraft is
 * not actually on, using the same corridorExcessKm and the same 300km bound
 * that join.ts applies to schedule rows -- a threshold that caught 6 of 17
 * wrong destinations on live data with zero false positives. A stale route for
 * a different leg puts the aircraft nowhere near the line between its claimed
 * endpoints, so it fails. That turns a 32%-wrong source into a usable last
 * resort: still wrong sometimes in the residual case where the wrong route
 * happens to run parallel to the right one, but no longer wrong in the common
 * case, and only ever consulted for flights that would otherwise render blank.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVIDE: an arrival time. Neither source has
 * one, so a flight routed this way keeps the physics ETA rather than gaining a
 * schedule-derived one. join.ts's temporal-plausibility bound therefore cannot
 * be applied to these at all -- it needs a scheduled arrival to test. The
 * corridor is the only gate available, and the code says so rather than
 * implying two checks are running when one is.
 */

export interface RouteFix {
  origIata: string;
  origLat: number;
  origLon: number;
  destIata: string;
  destLat: number;
  destLon: number;
  /** Which database answered. Surfaced for logging, not for the client. */
  source: 'adsbdb' | 'hexdb';
}

const ADSBDB = 'https://api.adsbdb.com/v0/callsign/';
const HEXDB = 'https://hexdb.io/callsign-route?callsign=';

/** How long a resolved route is trusted. Routes are stable day-to-day. */
const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a MISS is remembered.
 *
 * Much shorter than a hit, but not zero, and that asymmetry is the point: most
 * callsigns these databases do not know are ones they will never know (GA tail
 * numbers, military, charter). Re-asking on every 30-second cycle would spend
 * the entire request budget on flights that can never be resolved, so a miss is
 * cached too -- just briefly enough that a genuinely new route appearing in the
 * upstream database is picked up the same hour rather than the same day.
 */
const NEG_TTL_MS = 30 * 60 * 1000;

/**
 * How long a NON-answer is remembered.
 *
 * Note what the rationale above is actually about: a database that ANSWERED and
 * said it has no such route. None of it applies to a request that never got an
 * answer at all -- a timeout, a DNS failure, a 429, a 502. Those say "ask
 * again", not "this route does not exist", and treating them alike blanked a
 * callsign for half an hour over one slow response, on the module that exists
 * as the last resort for flights that would otherwise render blank. Worse, a
 * rate-limit or an IP-level block poisoned every callsign asked during it.
 *
 * 60s mirrors the firmware's equivalent cache (FlightDataFetcher.cpp), which
 * has always kept its failure TTL 30x shorter than its success TTL.
 */
const FAIL_TTL_MS = 60 * 1000;

/** Bounded so a long-running process cannot grow one entry per callsign seen. */
const MAX_ENTRIES = 2000;

interface Entry {
  fix: RouteFix | null;
  expiresMs: number;
}

const cache = new Map<string, Entry>();

/** Test-only: module state would otherwise leak between cases. */
export function resetRouteCache(): void {
  cache.clear();
}

export function routeCacheSize(): number {
  return cache.size;
}

function cacheGet(key: string, nowMs: number): Entry | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (e.expiresMs <= nowMs) {
    cache.delete(key);
    return undefined;
  }
  // Refresh insertion order so eviction below is least-recently-USED rather
  // than least-recently-written; a callsign overhead every cycle should not be
  // evicted just because it was first resolved a long time ago.
  cache.delete(key);
  cache.set(key, e);
  return e;
}

function cacheSet(key: string, fix: RouteFix | null, nowMs: number, answered = true): void {
  const ttl = fix ? TTL_MS : answered ? NEG_TTL_MS : FAIL_TTL_MS;
  cache.set(key, { fix, expiresMs: nowMs + ttl });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Parse adsbdb's callsign response. Never throws: a shape change upstream
 * degrades to "no route", same discipline as every other parser here.
 */
export function parseAdsbdb(body: unknown): RouteFix | null {
  const fr = (body as { response?: { flightroute?: unknown } } | undefined)?.response?.flightroute as
    | Record<string, unknown>
    | undefined;
  if (!fr || typeof fr !== 'object') return null;

  const o = fr.origin as Record<string, unknown> | undefined;
  const d = fr.destination as Record<string, unknown> | undefined;
  if (!o || !d) return null;

  const oLat = num(o.latitude), oLon = num(o.longitude);
  const dLat = num(d.latitude), dLon = num(d.longitude);
  const oIata = str(o.iata_code).toUpperCase();
  const dIata = str(d.iata_code).toUpperCase();
  // Both ends need coordinates or the corridor gate cannot run, and an
  // ungateable route is exactly the kind this module must not return.
  if (oLat === null || oLon === null || dLat === null || dLon === null) return null;
  if (!oIata || !dIata) return null;

  return { origIata: oIata, origLat: oLat, origLon: oLon, destIata: dIata, destLat: dLat, destLon: dLon, source: 'adsbdb' };
}

/**
 * Parse hexdb's reply, which is a bare `KLAX-KJFK` string rather than JSON --
 * ICAO codes only, no coordinates, so the bundled airport table supplies them.
 * A code the table does not cover yields null rather than a half-known route.
 */
export function parseHexdb(text: unknown): RouteFix | null {
  const s = str(text).toUpperCase();
  const m = /^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})$/.exec(s);
  if (!m) return null;
  const o = getAirportCoord(m[1]!);
  const d = getAirportCoord(m[2]!);
  if (!o || !d) return null;
  return { origIata: o.iata, origLat: o.lat, origLon: o.lon, destIata: d.iata, destLat: d.lat, destLon: d.lon, source: 'hexdb' };
}

/**
 * Is the aircraft actually on this route's corridor?
 *
 * The whole reason these sources are usable. Returns the route unchanged when
 * it survives, null when it does not, so a caller cannot accidentally use an
 * ungated result. No PRODUCTION path skips it -- flights.ts imports only
 * resolveGatedRoute -- but lookupRoute is exported and returns an ungated
 * RouteFix, so this is a convention the module surface does not enforce.
 */
export function gateRoute(fix: RouteFix, lat: number, lon: number): RouteFix | null {
  const excess = corridorExcessKm(lat, lon, fix.origLat, fix.origLon, fix.destLat, fix.destLon);
  if (!Number.isFinite(excess) || excess > MAX_CORRIDOR_EXCESS_KM) return null;
  return fix;
}

export interface LookupOptions {
  fetchImpl?: typeof fetch;
  /** Per-request bound. These are third-party free services; do not hang on them. */
  timeoutMs?: number;
}

/**
 * What one upstream request produced.
 *
 * The distinction that matters is `no-record` vs `unreachable`: both yield no
 * route right now, but only the first is EVIDENCE that there is no route. The
 * caller turns that into a 30-minute or a 60-second memory.
 */
type Answer =
  | { kind: 'body'; text: string }
  | { kind: 'no-record' }
  | { kind: 'unreachable' };

async function getText(url: string, opts: LookupOptions): Promise<Answer> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await doFetch(url, { signal: ac.signal, headers: { accept: '*/*' } });
    if (!res.ok) {
      // 429 and 5xx are the service declining to answer, not answering "no".
      // Everything else -- 404 above all, which is these APIs' normal way of
      // saying "not in this DB" -- is a real answer. Classifying narrowly is
      // deliberate: if a service ever served 5xx for a genuinely unknown
      // callsign, the cost is a 60s retry rather than a wrong permanent miss.
      return res.status === 429 || res.status >= 500
        ? { kind: 'unreachable' }
        : { kind: 'no-record' };
    }
    return { kind: 'body', text: await res.text() };
  } catch {
    // Timeout, DNS, transport. Deliberately silent: this runs per flight per
    // cycle, and a third-party service being briefly unreachable is an expected
    // condition, not an incident -- but it is not a negative result either.
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one callsign, cached. Tries adsbdb first (it carries coordinates and
 * an airline, so it needs no second lookup), then hexdb.
 *
 * NOT gated here: gating needs the aircraft's position, which this function has
 * no business knowing. The caller must pass the result through `gateRoute`;
 * `resolveGatedRoute` below does both and is what callers should normally use.
 */
export async function lookupRoute(
  callsign: string,
  nowMs: number,
  opts: LookupOptions = {},
): Promise<RouteFix | null> {
  const cs = callsign.trim().toUpperCase();
  if (!/^[A-Z]{3}\d/.test(cs)) return null; // tail numbers etc: never in these DBs

  const hit = cacheGet(cs, nowMs);
  if (hit) return hit.fix;

  // Whether BOTH services actually answered. If either one did not, a null
  // result is "we could not find out", which earns the short retry rather than
  // the long negative -- the other one might well have known.
  let answered = true;

  const a = await getText(ADSBDB + encodeURIComponent(cs), opts);
  if (a.kind === 'unreachable') answered = false;
  if (a.kind === 'body') {
    let parsed: RouteFix | null = null;
    try {
      parsed = parseAdsbdb(JSON.parse(a.text));
    } catch {
      parsed = null; // not JSON; fall through to hexdb
    }
    if (parsed) {
      cacheSet(cs, parsed, nowMs);
      return parsed;
    }
  }

  const h = await getText(HEXDB + encodeURIComponent(cs), opts);
  if (h.kind === 'unreachable') answered = false;
  const parsed = h.kind === 'body' ? parseHexdb(h.text) : null;
  cacheSet(cs, parsed, nowMs, answered);
  return parsed;
}

/** Resolve and gate in one step. The only form callers should need. */
export async function resolveGatedRoute(
  callsign: string,
  lat: number,
  lon: number,
  nowMs: number,
  opts: LookupOptions = {},
): Promise<RouteFix | null> {
  const fix = await lookupRoute(callsign, nowMs, opts);
  return fix ? gateRoute(fix, lat, lon) : null;
}
