import { haversineKm, bearingDeg, KM_PER_NM } from './geo';
import { etaMinutes, formatEta, TERMINAL_NM } from './eta';
import { matchSchedule } from './join';
import { airlineName } from './airlines';
import type { Aircraft, Flight, ScheduleRow } from './types';

export interface EnrichOptions {
  /**
   * Where the panel is. Used only when the position feed did not precompute
   * distance and bearing.
   *
   * ONE PAIR, not two independent optional scalars. Latitude without longitude
   * is not a location, and the old shape made that state representable and then
   * needed a second predicate to rule it out at the use site. Same defect class
   * as pairing the schedule row's coordinates, with none of the cost -- no
   * persisted shape, no KV_KEY bump, no rebuild window.
   */
  center?: { lat: number; lon: number };
}

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
 * covering ground, in kt, before the claimed time is one a DELAY has
 * already made unreachable.
 *
 * This is primarily a delay filter that happens to be expressed as a speed
 * bound, not a data-hygiene check. `schedArrEpoch` is the published
 * timetable entry and never moves once set (see ScheduleRow's own
 * comment): it is computed from a departure time, and if that departure
 * did not happen on time, the scheduled arrival still describes the
 * ON-TIME journey, not the one the aircraft is actually flying. A flight
 * running late enough still has a scheduled arrival ahead of "now" -- so
 * futureEpoch does not filter it out -- while being nowhere near able to
 * make it: the time is real, just for a journey delay has already ruled
 * out. A mismatched or genuinely stale row (a real time, but for a
 * different leg or day entirely) produces the identical symptom and is
 * caught the same way, but delay is the common case and mismatch the rare
 * one: most schedule-only rows that fail this check will be an ordinary
 * delayed flight, not a data error.
 *
 * That framing is also why this guard has to be read together with
 * `revArrEpoch`, not in isolation. Once the operator publishes a revised
 * time it is delay-aware by definition, and the priority chain below
 * checks and uses it before scheduled ever matters -- a plausible revised
 * time is simply correct. This guard is what covers the window BEFORE that
 * revision is published, or on rows where one never arrives at all: only
 * 102 of the 261 rows in the captured KJFK fixture carry a revised time at
 * all (see aerodatabox.ts's own commit message), so most rows have nothing
 * but the scheduled figure to fall back on if the flight they describe
 * turns out to be running late. The two mechanisms cover the same failure
 * from opposite ends of its timeline; removing either on the theory that
 * the other makes it redundant would reopen exactly the gap the other one
 * closes.
 *
 * The bound itself is derived from the airframe, not backed into the two
 * live failures below: subsonic airliners essentially never exceed ~510kt
 * true airspeed (Mach 0.89 at a cruise-altitude speed of sound of ~574kt --
 * already faster than most of the fleet flies). Past that, only wind can
 * add more, and a strong but genuinely SUSTAINED jet-stream push -- not a
 * one-minute gust core -- is on the order of 110kt. 510 + 110 = 620.
 *
 * That number happens to land between the two live failures:
 *   - THY6044 (660nm claimed in 15min = 2,640kt implied) fails by 4x -- a
 *     flight delayed badly enough that the countdown to its fixed
 *     scheduled arrival was already deep into the impossible. Any bound
 *     from 400kt to 1000kt catches it identically, so nothing about
 *     THY6044 drove the exact number. Its own live schedule row (as
 *     TK6044) shows the mechanism close up: scheduled 03:13Z (+13min,
 *     impossible for 660nm) sitting beside a since-published revised
 *     04:40Z (+100min, correct) -- the scheduled figure was never bad
 *     data, just a promise the delay had already broken.
 *   - DAL688 (2,099nm claimed in 200min = 630kt implied) fails by under 2%
 *     against this bound -- confirmed a heavily delayed flight, not a
 *     borderline-real one. That thin margin argues FOR the bound, not
 *     against it: a delayed flight's scheduled time degrades continuously
 *     as the delay grows, sitting just past the line early on and further
 *     past it the longer the delay runs. Catching DAL688 at 1.6% over means
 *     catching its delay near the start of that curve, not scraping in a
 *     marginal call -- the alternative is not "avoid a false positive", it
 *     is "wait for the number to get as obviously wrong as THY6044's before
 *     acting on it".
 *
 * A genuine fast leg can sit in that same numeric neighborhood, which is
 * the real, separate question this bound also has to weigh: British
 * Airways 112, JFK-LHR, rode Storm Ciara's jet stream to a widely-reported
 * 4h56m on 9 Feb 2020 (peak groundspeed 825mph/717kt, per contemporary
 * press coverage) -- ~2,992nm great-circle in 4h56m implies a ~606kt
 * average for the whole flight, comfortably under this bound. Real,
 * documented, not hypothetical (see enrich.test.ts for the worked case
 * this guard must NOT reject). DAL688 is additionally JFK->SEA, WESTbound,
 * a direction the jet stream (which blows west-to-east) opposes rather
 * than assists -- corroborating, once the delay is already confirmed, that
 * 630kt was never a tailwind on that flight specifically. This guard has
 * no way to use route direction directly -- it is a single scalar,
 * deliberately, the same blunt-instrument shape as join.ts's
 * corridorExcessKm -- so catching DAL688-shaped delays here necessarily
 * also means an exceptional EASTBOUND leg faster than ~620kt would be
 * rejected too, and fall through to physics instead of the real time it
 * actually has. Accepted anyway, because the two outcomes are not
 * symmetric: a false reject is cheap -- physics reads this SAME aircraft's
 * own live groundspeed, so a genuine tailwind leg is not blind to its own
 * tailwind there either -- while a false accept is not: it puts a
 * confidently wrong number on a 64px panel the viewer has no way to tell
 * from a real one.
 */
export const MAX_SCHEDULE_GS_KT = 620;

/**
 * A schedule-derived epoch is plausible only if the remaining distance is
 * coverable, at MAX_SCHEDULE_GS_KT, in the time it claims. If it is not,
 * the flight is most likely running late enough that its published time no
 * longer describes a journey it can still make (see MAX_SCHEDULE_GS_KT's
 * own comment) -- or, less commonly, the row is a real arrival time for a
 * different leg or day entirely. Either way it is treated exactly like a
 * failed futureEpoch check: as if the field had never been supplied, and
 * the chain moves on to the next candidate rather than handing an
 * impossible number to round()/formatEta.
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

  const row = matchSchedule(cs, a.lat, a.lon, rows, nowMs / 1000);

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
      etaMin = etaMinutes(nm, a.groundspeedKt ?? Number.NaN, a.altFt, a.verticalRateFpm);
      etaSrc = etaMin === null ? null : 'physics';
    }

    // Minute resolution only when etaMin counts down to a real arrival TIME
    // (revised or scheduled). The physics fallback keeps its coarse rounding --
    // see formatEta. Keyed off etaSrc rather than off arrivalEpoch so it cannot
    // drift from the value actually reported on the wire.
    etaText = formatEta(nm, etaMin, etaSrc === 'revised' || etaSrc === 'scheduled');
  }

  // Prefer the feed's precomputed values; adsb.lol ships both, so this
  // fallback is for sources that don't.
  let dstNm = a.distanceNm;
  let brg = a.bearingDeg;
  // One check, because the pair is one value. This used to test two optional
  // scalars for undefined independently.
  if (opts.center) {
    if (dstNm === null) dstNm = haversineKm(opts.center.lat, opts.center.lon, a.lat, a.lon) / KM_PER_NM;
    if (brg === null) brg = bearingDeg(opts.center.lat, opts.center.lon, a.lat, a.lon);
  }

  const round = (v: number | null): number | null => (v === null ? null : Math.round(v));

  return {
    cs,
    flt: row ? `${row.carrierIata}${row.number}` : null,
    al: row ? airlineName(row.carrierIata) ?? row.carrierIata : null,
    reg: a.registration,
    ac: a.typeIcao,
    from: row?.origIata ?? null,
    to: row?.destIata ?? null,
    alt: round(a.altFt),
    spd: round(a.groundspeedKt),
    hdg: round(a.trackDeg),
    vs: round(a.verticalRateFpm),
    // One decimal: the panel shows "12.4" but never "12.437".
    dst: dstNm === null ? 0 : Math.round(dstNm * 10) / 10,
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
