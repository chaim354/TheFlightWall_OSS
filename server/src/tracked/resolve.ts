import type { LatLon, ResolvedFlight } from './types';
import { fetchIcaoTypeCode } from './aircraftType';

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

/** UTC calendar date, "YYYY-MM-DD", for a whole-seconds epoch. */
const utcDateOf = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString().slice(0, 10);

/**
 * The calendar date at the DEPARTURE AIRPORT, from AeroDataBox's own local
 * timestamp -- "2026-08-24 12:30+01:00" -> "2026-08-24".
 *
 * Read straight off the string rather than converted from the UTC epoch,
 * because the offset that matters is the airport's, on that date, and the
 * payload already states it. Deriving it any other way would mean shipping a
 * timezone database to answer a question the response has already answered.
 */
const localDateOf = (localTime: unknown): string | null => {
  const s = str(localTime);
  if (!s) return null;
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

/**
 * AeroDataBox itself spells it "Canceled" (single-l); tolerate "Cancelled"
 * too since that is the more common spelling and a payload variant is cheap
 * to guard against.
 */
const CANCELED_STATUSES = new Set(['canceled', 'cancelled']);

const isCanceled = (row: Record<string, unknown>): boolean => {
  const status = str(row.status);
  return status !== null && CANCELED_STATUSES.has(status.toLowerCase());
};

/** Map one qualifying row to a ResolvedFlight. */
function toResolvedFlight(row: Record<string, unknown>): ResolvedFlight {
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
    // Uppercased to match the ADS-B callsigns every other path produces --
    // the device's prefix parse is case-insensitive, but the value also
    // reaches the panel as the flight number in the metric row.
    callsign: (() => { const c = str(row.callSign); return c ? c.toUpperCase() : null; })(),
    reg: str(aircraft.reg),
    aircraftModel: str(aircraft.model),
    // Not in this payload at all -- AeroDataBox carries a model name and no
    // type code. resolveFlight fills it from hexdb once the hex is known, so
    // this parser stays a pure function of the response it was given.
    aircraftType: null,
    origIata: str(depAirport?.iata),
    destIata: str(arrAirport?.iata),
    orig: coord(depAirport),
    dest: coord(arrAirport),
    schedDepEpoch: epoch((dep.scheduledTime as { utc?: unknown } | undefined)?.utc),
    schedArrEpoch: epoch((arr.scheduledTime as { utc?: unknown } | undefined)?.utc),
  };
}

/**
 * Map a by-number payload to the ONE row it actually means, or null if none
 * qualifies for `date`.
 *
 * The by-number-and-date endpoint does not return a single row: it returns
 * every leg using that flight number that touches the date window, which in
 * practice includes legs that are not the one a caller asking for "this
 * flight, this date" means. A live production fixture
 * (fixtures/aerodatabox-bynumber-multileg.json, DL182 on 2026-08-24) had
 * three: a cancelled leg that arrived that morning (actually yesterday's
 * departure), a same-numbered flight on a completely different aircraft, and
 * the actual en-route leg departing that date. Taking rows[0] blindly picked
 * the cancelled leg and its null departure time, and the whole feature sat
 * inert forever as a result -- see decideTracked's `resolved`-with-no-
 * departure-time handling in lifecycle.ts for the second half of that bug.
 *
 * `date` throughout is the calendar date at the DEPARTURE AIRPORT, not in UTC.
 *
 * Selection, in order:
 *   1. Drop cancelled rows.
 *   2. Require a scheduled departure time.
 *   3. Require that departure to fall on the REQUESTED `date` (UTC) -- this is
 *      what tells "today's departure" apart from "yesterday's departure that
 *      lands today", which is the actual confusion in the fixture above.
 *   4. Require both a departure and an arrival airport IATA -- this drops a
 *      same-numbered flight on a different aircraft that has no arrival on
 *      file yet.
 *   5. Of what is left, take the earliest scheduled departure.
 *
 * Returning a row whose `icao24` is null is NOT the same as returning null.
 * The first means "this flight exists, we just have no transponder address";
 * the second means "no qualifying row that day". The caller reports them
 * differently, and the spec flags the missing-modeS case as an explicit risk
 * to keep visible.
 */
export function parseByNumber(payload: unknown, date: string): ResolvedFlight | null {
  const rows = Array.isArray(payload) ? payload : [payload];

  let bestRow: Record<string, unknown> | null = null;
  let bestDepEpoch = Infinity;

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (isCanceled(row)) continue;

    const dep = (row.departure ?? {}) as Record<string, unknown>;
    const arr = (row.arrival ?? {}) as Record<string, unknown>;
    const depAirport = (dep.airport ?? null) as Record<string, unknown> | null;
    const arrAirport = (arr.airport ?? null) as Record<string, unknown> | null;

    const depEpoch = epoch((dep.scheduledTime as { utc?: unknown } | undefined)?.utc);
    if (depEpoch === null) continue;
    // `date` is the date AT THE DEPARTURE AIRPORT -- what a boarding pass says.
    // It used to be compared against the UTC date, which is a different day for
    // any evening departure west of Greenwich (a 20:55 JFK departure is already
    // tomorrow in UTC) and forced the person adding a flight to do that
    // conversion in their head. It also disagreed with the REQUEST: the
    // by-number endpoint reads its date parameter as local, so the filter was
    // rejecting on one definition what the query had asked for on another.
    //
    // Falls back to the UTC date only when a row carries no local timestamp,
    // which keeps a row that is otherwise usable from being dropped outright.
    const depLocalDate =
      localDateOf((dep.scheduledTime as { local?: unknown } | undefined)?.local) ??
      utcDateOf(depEpoch);
    if (depLocalDate !== date) continue;
    if (!str(depAirport?.iata) || !str(arrAirport?.iata)) continue;

    if (depEpoch < bestDepEpoch) {
      bestRow = row;
      bestDepEpoch = depEpoch;
    }
  }

  return bestRow ? toResolvedFlight(bestRow) : null;
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

  const flight = parseByNumber(payload, date);
  if (!flight) {
    return { ok: false, retryable: false, reason: `not operating ${date}` };
  }

  // One free, keyless hexdb call to turn the hex we just paid for into the same
  // ICAO type code an area card carries. Deliberately AFTER the success above
  // and unable to affect it: fetchIcaoTypeCode never throws and returns null on
  // every failure, leaving aircraftModel as the fallback. A resolve must not
  // become unresolvable because a cosmetic lookup was down.
  const aircraftType = flight.icao24 ? await fetchIcaoTypeCode(flight.icao24) : null;
  return { ok: true, flight: { ...flight, aircraftType } };
}
