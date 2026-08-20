import { corridorExcessKm } from './geo';
import type { ScheduleRow } from './types';

/**
 * How far off a claimed route corridor an aircraft may sit before we treat the
 * row as impossible. 300 km caught 6 of 17 wrong destinations on live data
 * with zero false positives.
 */
export const MAX_CORRIDOR_EXCESS_KM = 300;

/** Minimum geometric separation, km, before we call one row a better fit. */
const TIEBREAK_MARGIN_KM = 50;

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
 * null means "unknown operator, do not constrain" — geometry alone decides,
 * carrying whatever residual risk that already implies (see matchSchedule).
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
  if (allowed) {
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
