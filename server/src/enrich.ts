import { haversineKm, bearingDeg, KM_PER_NM } from './geo';
import { etaMinutes, formatEta, TERMINAL_NM } from './eta';
import { matchSchedule } from './join';
import { airlineName } from './airlines';
import type { Aircraft, Flight, ScheduleRow } from './types';

export interface EnrichOptions {
  units: 'imperial' | 'metric';
  /** Used only when the position feed did not precompute distance/bearing. */
  centerLat?: number;
  centerLon?: number;
}

const FT_PER_M = 3.28084;
const KMH_PER_KT = 1.852;

/**
 * An arrival epoch counts as a usable source only if it is still ahead of
 * now. A revised or scheduled arrival in the past means the record is
 * stale -- the flight has already landed by the operator's own account (a
 * runwayTime would confirm it, but we don't fetch that), or the row simply
 * never got updated. Either way it is not a source for a FUTURE eta, so it
 * is treated exactly as if it had never been supplied and the chain moves
 * on to the next candidate, rather than surfacing a zero or negative
 * number. `>=` (not `>`) so an epoch equal to `nowSec` -- arriving this
 * instant -- still counts: that is a real (zero-minute) answer, not a stale
 * one.
 */
function futureEpoch(epochSec: number | null, nowSec: number): number | null {
  return epochSec !== null && epochSec >= nowSec ? epochSec : null;
}

/**
 * How fast a schedule-derived arrival can plausibly imply the aircraft is
 * covering ground, in kt, before the row is more likely stale or mismatched
 * than genuinely fast. A schedule time carries no internal signal that it is
 * wrong the way a physics estimate does -- physics is anchored to the
 * aircraft's own live position and speed, so a bad value tends to look
 * strange; a bad schedule time looks exactly like a good one until checked
 * against geometry. This is that check, for time instead of route -- same
 * spirit as join.ts's corridorExcessKm, which rejects a route the
 * aircraft's position makes impossible.
 *
 * Derived from the airframe, not backed into the two live failures below:
 * subsonic airliners essentially never exceed ~510kt true airspeed (Mach
 * 0.89 at a cruise-altitude speed of sound of ~574kt -- already faster than
 * most of the fleet flies). Past that, only wind can add more, and a
 * strong but genuinely SUSTAINED jet-stream push -- not a one-minute gust
 * core -- is on the order of 110kt. 510 + 110 = 620.
 *
 * That number happens to land between the two live failures, which is the
 * whole difficulty this guard exists to navigate:
 *   - THY6044 (660nm claimed in 15min = 2,640kt implied) fails by 4x. No
 *     credible wind explains that; any bound from 400kt to 1000kt catches
 *     it identically, so nothing about THY6044 drove the exact number.
 *   - DAL688 (2,099nm claimed in 200min = 630kt implied) fails by under 2%
 *     against this bound. That is inside the noise of exactly how generous
 *     "sustained" should be, and a genuine storm-assisted eastbound
 *     Atlantic crossing DOES reach this neighborhood: British Airways 112,
 *     JFK-LHR, rode Storm Ciara's jet stream to a widely-reported 4h56m on
 *     9 Feb 2020 (peak groundspeed 825mph/717kt, per contemporary press
 *     coverage) -- ~2,992nm great-circle in 4h56m implies a ~606kt average
 *     for the whole flight. Real, documented, not hypothetical (see
 *     enrich.test.ts for the worked case this guard must NOT reject).
 * DAL688 is kept as a reject anyway, deliberately: it is JFK->SEA,
 * WESTbound, a direction the jet stream (which blows west-to-east) opposes
 * rather than assists, so the one physical mechanism that could excuse a
 * 600+kt average does not apply to it the way it would an eastbound
 * Atlantic leg. This guard has no way to use that fact directly -- it is a
 * single scalar, deliberately, with no notion of route direction -- so
 * catching DAL688 here necessarily also means an exceptional EASTBOUND leg
 * faster than ~620kt would be rejected too, and fall through to physics
 * instead of the real time it actually has. Accepted anyway, because the
 * two outcomes are not symmetric: a false reject is cheap -- physics reads
 * this SAME aircraft's own live groundspeed, so a genuine tailwind leg is
 * not blind to its own tailwind there either -- while a false accept is
 * not: it puts a confidently wrong number on a 64px panel the viewer has no
 * way to tell from a real one.
 */
export const MAX_SCHEDULE_GS_KT = 620;

/**
 * A schedule-derived epoch is plausible only if the remaining distance is
 * coverable, at MAX_SCHEDULE_GS_KT, in the time it claims. If it is not,
 * the row is stale or mismatched -- a real arrival time, just not for this
 * leg or this day -- so it is treated exactly like a failed futureEpoch
 * check: as if the field had never been supplied, and the chain moves on to
 * the next candidate rather than handing an impossible number to
 * round()/formatEta.
 *
 * Below TERMINAL_NM this check does not run: at short range, one minute of
 * rounding in the schedule feed (times are minute-granular, not
 * second-granular) swings the implied speed by tens of knots on its own,
 * and straight-line distance stops tracking actual remaining track once
 * vectoring, holds and go-arounds enter the picture -- the same reasons
 * etaMinutes (eta.ts) stops trusting a computed speed at that same
 * threshold. A row with no destination coordinates (nm is NaN, see below)
 * is likewise something this check cannot evaluate, so it is let through
 * unexamined rather than penalized for a check it has no way to pass or
 * fail.
 */
function plausibleEpoch(epochSec: number | null, nowSec: number, nm: number): number | null {
  if (epochSec === null) return null;
  if (!Number.isFinite(nm) || nm <= TERMINAL_NM) return epochSec;
  const minMinutesRequired = (nm / MAX_SCHEDULE_GS_KT) * 60;
  return (epochSec - nowSec) / 60 >= minMinutesRequired ? epochSec : null;
}

/**
 * One aircraft plus the schedule -> one display-ready flight, or null to drop it.
 *
 * A schedule miss is NOT a failure: the flight still renders with its callsign,
 * position and live metrics, just without a route. That is the whole design
 * stance — blank beats a confident wrong city on a 64px panel.
 *
 * `nowMs` is threaded in rather than read via Date.now() inside this
 * function: enrich() is pure and unit-tested (like eta.ts), and reaching for
 * the wall clock here would make "what did this return for this input" a
 * question with no fixed answer.
 */
export function enrich(a: Aircraft, rows: readonly ScheduleRow[], opts: EnrichOptions, nowMs: number): Flight | null {
  const cs = a.callsign.trim();
  if (!cs) return null; // no identity, not worth a slot

  const row = matchSchedule(cs, a.lat, a.lon, rows);

  let etaMin: number | null = null;
  let etaText: string | null = null;
  let etaSrc: Flight['eta_src'] = null;

  if (row) {
    const nowSec = nowMs / 1000;

    // Distance to destination, when the row has coordinates for it. Needed
    // for the physics model below, for the plausibility guard the epochs
    // pass through next, and ALSO for formatEta's LANDING/rounding contract
    // regardless of which source produced etaMin -- that display contract
    // does not change with the source, only the number it is applied to.
    // NaN when coordinates are missing; formatEta already treats a
    // non-finite distance as "cannot confirm LANDING by proximity" and
    // falls through to its ordinary rounding, and plausibleEpoch likewise
    // treats it as "cannot check, don't reject", so this needs no extra
    // branching here.
    const nm = row.destLat !== null && row.destLon !== null
      ? haversineKm(a.lat, a.lon, row.destLat, row.destLon) / KM_PER_NM
      : Number.NaN;

    // Priority chain -- a real arrival time beats any model, because it
    // already accounts for climb, cruise, descent, routing, taxi and the
    // actual delay (see eta.ts's own header comment on everything the
    // physics model can't know). Revised beats scheduled because it is the
    // delay-aware figure; either beats physics because a schedule entry is
    // a fact about a plan, not a guess about the future. Physics remains
    // the fallback: it runs when neither time is usable below.
    //
    // Each tier passes through two independent filters before it is
    // eligible: futureEpoch rejects a time already in the past, and
    // plausibleEpoch rejects a time geometry says cannot be true. Both are
    // applied PER TIER, exactly like the existing past-arrival handling --
    // a revised time that fails either check must not drag down a
    // perfectly good scheduled time sitting right next to it.
    const revEpoch = plausibleEpoch(futureEpoch(row.revArrEpoch, nowSec), nowSec, nm);
    const schedEpoch = plausibleEpoch(futureEpoch(row.schedArrEpoch, nowSec), nowSec, nm);
    const arrivalEpoch = revEpoch ?? schedEpoch;

    if (arrivalEpoch !== null) {
      etaMin = (arrivalEpoch - nowSec) / 60;
      etaSrc = revEpoch !== null ? 'revised' : 'scheduled';
    } else if (row.destLat !== null && row.destLon !== null) {
      // a.altFt is always feet (source units), independent of opts.units --
      // the metric conversion below only affects the *displayed* alt field,
      // not this value, so the descent floor never needs converting.
      etaMin = etaMinutes(nm, a.groundspeedKt ?? Number.NaN, a.altFt);
      etaSrc = etaMin === null ? null : 'physics';
    }

    etaText = formatEta(nm, etaMin);
  }

  // Prefer the feed's precomputed values; adsb.lol ships both, so this
  // fallback is for sources that don't.
  let dstNm = a.distanceNm;
  let brg = a.bearingDeg;
  if (opts.centerLat !== undefined && opts.centerLon !== undefined) {
    if (dstNm === null) dstNm = haversineKm(opts.centerLat, opts.centerLon, a.lat, a.lon) / KM_PER_NM;
    if (brg === null) brg = bearingDeg(opts.centerLat, opts.centerLon, a.lat, a.lon);
  }

  const metric = opts.units === 'metric';
  const round = (v: number | null): number | null => (v === null ? null : Math.round(v));

  return {
    cs,
    flt: row ? `${row.carrierIata}${row.number}` : null,
    al: row ? airlineName(row.carrierIata) ?? row.carrierIata : null,
    reg: a.registration,
    ac: a.typeIcao,
    from: row?.origIata ?? null,
    to: row?.destIata ?? null,
    alt: round(a.altFt === null ? null : metric ? a.altFt / FT_PER_M : a.altFt),
    spd: round(a.groundspeedKt === null ? null : metric ? a.groundspeedKt * KMH_PER_KT : a.groundspeedKt),
    hdg: round(a.trackDeg),
    vs: round(a.verticalRateFpm === null ? null : metric ? a.verticalRateFpm / FT_PER_M : a.verticalRateFpm),
    // One decimal: the panel shows "12.4" but never "12.437".
    dst: dstNm === null ? 0 : Math.round((metric ? dstNm * KM_PER_NM : dstNm) * 10) / 10,
    brg: brg === null ? 0 : Math.round(brg),
    eta_min: round(etaMin),
    eta_text: etaText,
    // etaSrc is already kept in lock-step with etaMin above (set alongside
    // it in every branch, including the null ones), so no extra guard is
    // needed here the way the old physics-only line needed `etaMin === null
    // ? null : 'physics'`.
    eta_src: etaSrc,
  };
}
