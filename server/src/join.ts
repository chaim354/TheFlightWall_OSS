import { corridorExcessKm, haversineKm, KM_PER_NM } from './geo';
import type { ScheduleRow } from './types';

/**
 * How far off a claimed route corridor an aircraft may sit before we treat the
 * row as impossible. 300 km caught 6 of 17 wrong destinations on live data
 * with zero false positives.
 */
export const MAX_CORRIDOR_EXCESS_KM = 300;

/** Minimum geometric separation, km, before we call one row a better fit. */
const TIEBREAK_MARGIN_KM = 50;

/**
 * Slowest groundspeed an airborne scheduled flight is assumed to make good
 * over the rest of its leg, for the "is this aircraft even on this leg" test
 * below. Deliberately far below any airliner's cruise -- a turboprop makes
 * ~250kt and a jet 400-500 -- because this bound exists to reject rows that
 * are wrong by HOURS, not to model flight time. Anything tighter would start
 * arguing with headwinds.
 */
const MIN_ENROUTE_GS_KT = 180;

/**
 * Added on top, for time the aircraft may spend not making progress toward
 * the destination at all: holds, vectoring, a ground stop before an
 * en-route leg, a diversion and recovery.
 */
const ENROUTE_SLACK_MIN = 180;

/**
 * Could an aircraft here still be flying the leg this row describes?
 *
 * WHY THIS EXISTS. Geometry alone cannot answer it. Every board this server
 * watches is NYC-area, so a corridor into or out of NYC passes near an
 * aircraft over NYC almost by construction -- the corridor check discards
 * geometrically impossible rows (SFO->LAX seen over New York) but is nearly
 * blind between a row for THIS leg and a row for the same flight number on a
 * different day. Measured live: TCN719, an operator not in CARRIER_CANDIDATES,
 * matched `B6 719 JFK->ATL` and rendered a route and an 11h30 ETA. There was
 * only ONE candidate for number 719, so the tiebreak never ran; the corridor
 * excess was ~0 because the aircraft was over JFK and the row starts at JFK.
 * What actually disqualified that row was time: it was scheduled to land at
 * 03:46Z the following day, i.e. to DEPART about nine hours after the aircraft
 * being matched was already in the air.
 *
 * THE BOUND IS ONE-SIDED, and only the far side. A row is rejected when its
 * arrival is implausibly FAR away for the distance still to run. It is never
 * rejected for being too soon -- enrich.ts's plausibleEpoch already owns that
 * direction for the ETA, and applying it here would throw away the route as
 * well as the time.
 *
 * DELAYS PASS, and that is why the SCHEDULED time is used rather than the
 * revised one. A delay moves the revised arrival LATER while the scheduled
 * arrival stays put or slides into the past, so testing the scheduled time
 * cannot punish a late-running flight -- exactly the DAL688 case this project
 * has already been bitten by. What moves a scheduled arrival implausibly far
 * into the future is not delay; it is the row belonging to another day.
 *
 * A row this cannot evaluate -- no arrival time, or no destination
 * coordinates -- is let THROUGH rather than rejected. That is the opposite of
 * excessFor's stance on missing coordinates, and deliberately so: a missing
 * corridor makes a row uncheckable against the strongest signal available,
 * whereas a missing time leaves the corridor check still doing its job, and
 * rejecting on it would blank every row from a provider that supplies routes
 * without arrival times.
 */
function temporallyPlausible(r: ScheduleRow, lat: number, lon: number, nowSec: number): boolean {
  const arrival = r.schedArrEpoch ?? r.revArrEpoch;
  if (arrival === null) return true; // nothing to test against
  if (r.destLat === null || r.destLon === null) return true; // no distance to test with

  const nm = haversineKm(lat, lon, r.destLat, r.destLon) / KM_PER_NM;
  const maxMinutes = (nm / MIN_ENROUTE_GS_KT) * 60 + ENROUTE_SLACK_MIN;
  return (arrival - nowSec) / 60 <= maxMinutes;
}

export interface CallsignKey {
  operator: string;
  number: string;
}

/**
 * Split an ADS-B callsign into its operator prefix and trailing flight number.
 *
 * The number must be a TRAILING digit run, not the first digits anywhere in the
 * string. Matching the first run instead mis-keys alphanumeric callsigns:
 * IBE03ZD would key as "3" and collide with everything.
 *
 * Returns null for shapes with no derivable flight number — tail numbers, and
 * the ~7% of airline callsigns that end in letters. British Airways transmits
 * BAW2LJ for flight BA1228; there is no relationship to recover.
 */
export function callsignKey(callsign: string): CallsignKey | null {
  const cs = callsign.trim().toUpperCase();
  if (!/^[A-Z]{3}\d/.test(cs)) return null;
  const m = /(\d+)$/.exec(cs);
  if (!m || !m[1]) return null;
  const number = m[1].replace(/^0+/, '') || '0';
  return { operator: cs.slice(0, 3), number };
}

/**
 * Which marketing carriers an operator's flights can be sold under.
 *
 * This exists because ADS-B carries the OPERATOR and a schedule row carries the
 * MARKETING CARRIER, and for regional-operated flights they differ. Measured on
 * live NYC traffic: the two agree for only 51% of flights.
 *
 * Single-partner regionals are safe to pin. Multi-partner ones are NOT — RPA was
 * observed flying as AA three times and DL twice in one sample — so they list
 * every partner and let geometry break the tie.
 *
 * null means "unknown operator" — and matchSchedule now declines the match
 * outright rather than letting geometry decide alone, because on live traffic
 * that fallback produced only wrong routes. See the comment at its use.
 *
 * A known operator is different: it can only ever narrow candidates, never
 * widen them, and matchSchedule returns null rather than widening back to the
 * unconstrained set when narrowing excludes everything. So an incomplete
 * table — missing an operator, or listing fewer carriers than it actually
 * flies for — degrades to more blanks, never to a wrong route.
 */
const CARRIER_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  // Mainline: operator is the carrier.
  AAL: ['AA'], DAL: ['DL'], UAL: ['UA'], JBU: ['B6'], SWA: ['WN'],
  ASA: ['AS'], NKS: ['NK'], FFT: ['F9'], HAL: ['HA'], AAY: ['G4'],
  // Single-partner regionals.
  EDV: ['DL'],                 // Endeavor Air -> Delta
  ENY: ['AA'],                 // Envoy Air -> American
  JIA: ['AA'],                 // PSA Airlines -> American
  PDT: ['AA'],                 // Piedmont -> American
  AWI: ['AA'],                 // Air Wisconsin -> American
  UCA: ['UA'],                 // CommuteAir -> United
  QXE: ['AS'],                 // Horizon Air -> Alaska
  // Multi-partner regionals: geometry must disambiguate.
  RPA: ['AA', 'DL', 'UA'],     // Republic
  SKW: ['AA', 'DL', 'UA', 'AS'], // SkyWest
  ASH: ['AA', 'UA'],           // Mesa
  GJS: ['UA', 'DL'],           // GoJet
};

export function candidateCarriers(operatorIcao: string): readonly string[] | null {
  return CARRIER_CANDIDATES[operatorIcao.toUpperCase()] ?? null;
}

/**
 * Find the schedule row for a live aircraft, or null.
 *
 * Order matters:
 *   1. Exact operating-callsign match, when the provider ships one. No
 *      ambiguity, no tables, nothing to get wrong.
 *   2. Otherwise: match the flight NUMBER, narrow by carrier candidates,
 *      then break any remaining tie geometrically.
 *
 * Ambiguity that survives all of it returns null. On a 64px panel a blank
 * route is strictly better than a confident wrong city.
 */
export function matchSchedule(
  callsign: string,
  lat: number,
  lon: number,
  rows: readonly ScheduleRow[],
  nowSec: number,
): ScheduleRow | null {
  const cs = callsign.trim().toUpperCase();

  // 1. Exact match on the operating callsign.
  const exact = rows.filter((r) => r.callsign && r.callsign.trim().toUpperCase() === cs);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null; // provider gave us duplicates; do not guess

  // 2. Number, then carrier, then geometry.
  const key = callsignKey(cs);
  if (!key) return null;

  let candidates = rows.filter((r) => r.number === key.number);
  if (candidates.length === 0) return null;

  const allowed = candidateCarriers(key.operator);
  if (!allowed) {
    // UNKNOWN OPERATOR -> no route. It reached here having already failed the
    // exact-callsign path above, so nothing is left but number + geometry,
    // and geometry cannot carry that weight: every board this server watches
    // is NYC-area, so a corridor into or out of NYC passes near an aircraft
    // over NYC almost by construction. A lone same-number row is then
    // returned outright, with nothing having actually corroborated it.
    //
    // Measured on live traffic, and the split was total. Of six
    // unknown-operator aircraft overhead, the three the schedule ALSO carried
    // an operating callsign for (ITY608 ITA Airways, EJA743 NetJets, KAP5483
    // Cape Air) were matched correctly by the exact path. The three it did not
    // (JKR57, EJM290, TCN719) were each matched to an unrelated airline row
    // sharing only a flight number -- EJM290, an Executive Jet Management
    // business jet, became `AS290 EWR->PDX` with a 9h30 ETA; TCN719 became
    // `B6 719 JFK->ATL` with an 11h30 one.
    //
    // So the schedule table itself already answers "is this operator running
    // scheduled service here": if it is, it ships the callsign and the exact
    // path matches. Guessing past that point only ever produced wrong
    // answers, which on a 64px panel are indistinguishable from right ones.
    return null;
  }
  {
    // A known operator is positive information, not a hint: we know every
    // carrier it can fly for, and none of the rows sharing this number
    // belong to one of them. That means the true row is simply missing from
    // this fetch -- a same-number collision with an unrelated carrier is not
    // a substitute for it, and geometry cannot be trusted to catch the
    // substitution: every board this Worker watches is NYC-area, so a wrong
    // NYC-bound row often sits just as close to the corridor as the right
    // one. (This is how EDV5075, its real DL row missing from the fetch,
    // used to lock onto an unrelated WN5075 MDW-LGA row -- corridor excess
    // was measured against geometrically *impossible* routes like SFO-LAX
    // seen over New York, never against two equally plausible NYC-bound
    // ones.) No candidate survives narrowing -> no route, full stop.
    candidates = candidates.filter((r) => allowed.includes(r.carrierIata));
    if (candidates.length === 0) return null;
  }

  // Drop rows this aircraft could not still be flying. Applied BEFORE the
  // geometry scoring below, not after, because the failure it catches is one
  // geometry cannot see: a single surviving candidate is returned outright
  // (`scored.length === 1`), so the tiebreak never gets a chance to be
  // sceptical about it. See temporallyPlausible.
  candidates = candidates.filter((r) => temporallyPlausible(r, lat, lon, nowSec));
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((r) => ({ row: r, excess: excessFor(r, lat, lon) }))
    .filter((c) => c.excess !== null && c.excess <= MAX_CORRIDOR_EXCESS_KM)
    .sort((a, b) => a.excess! - b.excess!);

  if (scored.length === 0) return null;
  if (scored.length === 1) return scored[0]!.row;

  // Two or more plausible rows: only choose if one is clearly the better fit.
  const [best, next] = scored;
  return next!.excess! - best!.excess! >= TIEBREAK_MARGIN_KM ? best!.row : null;
}

/**
 * Corridor deviation for a row, or null when the row lacks the coordinates to
 * judge it. A row we cannot check is not a row we should trust — returning null
 * drops it from consideration rather than letting it through unchecked.
 */
function excessFor(r: ScheduleRow, lat: number, lon: number): number | null {
  if (r.destLat === null || r.destLon === null) return null;
  if (r.origLat === null || r.origLon === null) return null;
  return corridorExcessKm(lat, lon, r.origLat, r.origLon, r.destLat, r.destLon);
}
