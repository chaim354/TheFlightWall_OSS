import type { Aircraft } from '../types';
import type { LatLon } from './types';
import { deadReckonAt } from './deadReckon';

/**
 * Find a flight's Mode S hex from live ADS-B when the schedule provider has none.
 *
 * WHY THIS EXISTS. AeroDataBox supplies the aircraft for most mainline flights
 * and frequently not for regional ones. MEASURED 2026-08-25: AA3964 returned
 * `modeS: null` AND `callSign: null` on both legs, so the entry resolved with a
 * route and a schedule and nothing to poll -- OpenSky is keyed on the hex, so
 * the flight simply could not be followed.
 *
 * The obvious fix does not work. A callsign lookup needs the OPERATING
 * callsign, and nothing in this pipeline can derive it: AA3964 flies as
 * ENY3964 for Envoy, and "AA" does not encode which regional carrier operates
 * a given number (Envoy, PSA, Piedmont, SkyWest and Republic all fly as
 * American). Checked and rejected on the day: AeroDataBox's callSign was null,
 * and adsbdb resolves ICAO callsigns but will not map a marketing number to
 * one.
 *
 * What IS derivable is the flight number's digits. ENY3964 and AA3964 share
 * "3964", and a live ADS-B sweep of where the aircraft should currently be
 * turns that into a hex without knowing the operator at all.
 */

/**
 * Search radius around the estimated position.
 *
 * The estimate comes from the SCHEDULE, so it is wrong by however late the
 * flight actually is, and the tick is 300s so it can be five minutes stale on
 * top of that. At ~450kt five minutes is ~37nm, and a modest departure delay
 * costs more again -- 120nm absorbs both without widening to the point where
 * unrelated same-numbered traffic starts appearing. Ambiguity is refused
 * rather than guessed at (see matchByFlightNumber), so a wider net would trade
 * finds for refusals, not for wrong answers.
 */
export const SEARCH_RADIUS_NM = 120;

/**
 * The digits of an IATA flight number, carrier prefix removed.
 *
 * THE PREFIX IS EXACTLY TWO CHARACTERS, and that is the whole point: an IATA
 * carrier code can CONTAIN a digit. "B6615" is JetBlue 615, not 6615, and it
 * is broadcast as JBU615 -- so taking the trailing digit run of the flight
 * number (as the callsign side correctly does) yields "6615" and matches
 * nothing. The same breaks 9W, W6, U2, F9, G4 and 5X.
 *
 * Falls back to the trailing run when the remainder is not all digits, which
 * is what a three-letter ICAO form like BAW181 needs. Null when there are no
 * trailing digits at all -- a shape this cannot match on and must not pretend
 * to (BAW2LJ really is unrecoverable).
 *
 * Leading zeros go because the two sides disagree about them: a schedule's
 * "DL0089" is broadcast as "DAL89".
 */
export function flightNumberDigits(number: string): string | null {
  const s = number.trim().toUpperCase();
  const rest = s.slice(2);
  if (rest && /^\d+$/.test(rest)) return rest.replace(/^0+/, '') || '0';
  return callsignDigits(s);
}

/**
 * The trailing digit run of an ADS-B callsign.
 *
 * Trailing, not the first run anywhere -- the same rule callsignKey uses and
 * for the same reason: keying "IBE03ZD" on its first digits would collide with
 * everything. An ICAO operator prefix is always three LETTERS, so unlike the
 * IATA side there is no digit in the prefix to trip over.
 */
export function callsignDigits(callsign: string): string | null {
  const m = /(\d+)$/.exec(callsign.trim().toUpperCase());
  if (!m || !m[1]) return null;
  return m[1].replace(/^0+/, '') || '0';
}

export interface HexMatch {
  hex: string;
  callsign: string;
  registration: string | null;
  typeIcao: string | null;
}

/**
 * The one aircraft in `nearby` whose callsign carries this flight's number.
 *
 * REFUSES AMBIGUITY. Two carriers can both be flying a 3964, and a wrong hex
 * puts a wrong aircraft on the panel where it is indistinguishable from a
 * right one -- so more than one candidate returns null, exactly as
 * matchSchedule does when the provider hands it duplicate rows. The cost of
 * refusing is a flight that stays untracked and says so; the cost of guessing
 * is a flight that looks tracked and is not.
 *
 * On-ground aircraft are skipped: a jet still at the gate with its callsign
 * already set is not the flight in the air, and adopting it would render a
 * stationary aircraft as airborne.
 */
export function matchByFlightNumber(nearby: readonly Aircraft[], number: string): HexMatch | null {
  const want = flightNumberDigits(number);
  if (!want) return null;

  const hits = nearby.filter(
    (a) => a.hex && a.callsign && !a.onGround && callsignDigits(a.callsign) === want,
  );
  if (hits.length !== 1) return null;

  const a = hits[0]!;
  return {
    hex: a.hex.toLowerCase(),
    callsign: a.callsign.trim().toUpperCase(),
    registration: a.registration,
    typeIcao: a.typeIcao,
  };
}

export interface FindHexRoute {
  orig: LatLon | null;
  dest: LatLon | null;
  depMs: number | null;
  arrMs: number | null;
}

/**
 * Where to sweep for this flight right now.
 *
 * deadReckonAt rather than "near the origin": the origin is only the right
 * place to look for the first few minutes, and the tick can easily miss that
 * window -- it did on the day this was written, by 35 minutes. Estimating
 * along the route instead keeps the search useful for the whole flight, and
 * reuses the same interpolation serve.ts already renders positions with.
 *
 * Null when the route is incomplete, which is the same honest refusal
 * deadReckonAt makes: half a route gives a position worse than no position.
 */
export function searchCentre(route: FindHexRoute, nowMs: number): LatLon | null {
  return deadReckonAt(route, nowMs);
}
