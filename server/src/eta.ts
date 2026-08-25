// Pure ETA model. No I/O.
//
// THIS IS NOW THE FALLBACK, not the primary source. enrich.ts prefers a real
// arrival time from the schedule table (AeroDataBox's revised or scheduled
// time) whenever one is available -- an operator's own estimate already
// accounts for climb, cruise, descent, routing, taxi and any actual delay,
// which is strictly more than a position/speed/altitude snapshot can ever
// infer. This model still runs, unchanged, whenever no schedule-based time
// exists: no schedule match, or a match with neither time usable. Everything
// below describes that fallback model on its own terms; see enrich.ts for
// how it fits into the larger priority chain.
//
// A naive distance/groundspeed is optimistic by a roughly CONSTANT ~10 minutes
// at any range above the terminal area, because the aircraft always owes the
// same deceleration whether it is 200 nm out or 800. Measured against the naive
// model:
//
//   phase                d(nm)  gs(kt)   naive    2-seg    diff
//   cruise, 800nm out      800     470  102.1m   112.5m  +10.3m
//   cruise, 200nm out      200     450   26.7m    36.7m  +10.0m
//   top of descent         120     400   18.0m    27.0m   +9.0m
//   descending              60     300   12.0m    18.0m   +6.0m
//   approach                25     220    6.8m     7.5m   +0.7m
//   final                    8     150    3.2m     2.4m   -0.8m
//
// That is a 10% error on a transatlantic and a 50% error at 60 nm out, which is
// exactly the range a viewer is watching.
//
// All of the above is horizontal only. It has no opinion on altitude, which
// is fine right up until an aircraft is horizontally close to its destination
// while still at cruise -- a hold, a go-around, or a route that overflies its
// own destination on the way to a later leg. Horizontal distance is not
// time-to-go when a full descent still remains, so etaMinutes also takes a
// descent-time floor from altitude; see NOMINAL_DESCENT_FPM below.

/** Distance-to-go, in nm, below which we stop trusting current groundspeed. */
export const TERMINAL_NM = 60;

/** Nominal average groundspeed, kt, across the terminal segment. */
export const TERMINAL_KT = 200;

/** Minutes the terminal segment costs. Derived, not hardcoded. */
export const TERMINAL_MIN = (TERMINAL_NM / TERMINAL_KT) * 60;

/**
 * Distance-to-go, in nm, below which we show LANDING instead of a number.
 *
 * NOTE this is a DIFFERENT threshold from TERMINAL_NM and deliberately so.
 * TERMINAL_NM is where the MODEL changes; LANDING_NM is where the DISPLAY
 * stops claiming precision it does not have. The model still produces a value
 * inside 30 nm — we decline to show it.
 */
export const LANDING_NM = 30;

/**
 * Nominal descent rate, ft/min, used only as a floor -- see etaMinutes.
 *
 * Real jets fly 1,500-2,500 fpm during a descent: faster up high, slower near
 * the ground. This does not model that profile; it only needs one number to
 * answer "how long does shedding this much altitude take, at minimum".
 * Deliberately picked from the slow half of that range: a lower rate gives a
 * LARGER floor, i.e. a LONGER reported ETA. Overstating time remaining is a
 * rounding error to a viewer; telling them a cruising aircraft is landing is
 * a false statement of fact. When the two disagree, the floor should err
 * cautious, never eager.
 */
export const NOMINAL_DESCENT_FPM = 1800;

/**
 * Vertical rate above which an aircraft is treated as genuinely climbing
 * rather than holding altitude with noise on the reading. ADS-B vertical
 * rates jitter by a few hundred fpm at cruise.
 */
export const CLIMB_VS_FPM = 500;

/**
 * Altitude at or above which a jet's groundspeed is taken as representative
 * of the rest of its flight. Below it, while climbing, it is not: the
 * aircraft is still accelerating, and (mostly) still under the 250kt
 * indicated limit or only just out of it.
 */
export const CRUISE_ALT_FT = 28000;

/**
 * Groundspeed at or above which a climbing aircraft is taken to be a jet.
 *
 * This gate is what keeps the correction below from wrecking slow traffic. A
 * Cessna 402 climbing out of Saranac Lake for JFK makes ~110kt and will
 * cruise at ~180 -- projecting it to a jet cruise speed would understate its
 * ETA by more than half, which is the error this whole file is most careful
 * to avoid. A jet passing 10,000ft is already doing 280-320kt.
 */
export const JET_CLIMB_MIN_KT = 200;

/**
 * Remaining distance at or beyond which a climbing aircraft is taken to be a
 * jet REGARDLESS of its current groundspeed.
 *
 * Speed alone is not enough, and live traffic proved it: JBU1371, an A320
 * out of LGA for FLL, was passing 1,825ft at 184kt -- unambiguously a jet,
 * unambiguously below JET_CLIMB_MIN_KT, because it was barely a minute off
 * the runway and still accelerating. The speed gate alone left it reading
 * 5h02 for a leg of about two and a half hours. In the first minute of a
 * climb an airliner and a light twin genuinely do look alike on speed.
 *
 * Leg length separates them where speed cannot: 930nm is not a distance a
 * piston twin flies. The Cape Air case above was a 250nm hop, well inside
 * this. The residual exposure is a turboprop on a genuinely long leg -- a
 * Dash 8 doing 450nm would be projected to jet cruise and understated -- but
 * that combination is rare in this airspace, and it is bounded, whereas the
 * error being removed was measured at +235%.
 */
export const JET_LEG_MIN_NM = 400;

/**
 * Groundspeed a climbing jet is assumed to make good once at cruise.
 *
 * Picked from the SLOW end of the real range (a long-haul twin typically
 * makes 460-500kt over the ground in still air) for the same reason
 * NOMINAL_DESCENT_FPM is picked slow: it biases the answer toward
 * overstating time remaining, which is a rounding error to a viewer, rather
 * than understating it, which is a false statement of fact on a panel with
 * no room to qualify it.
 */
export const NOMINAL_CRUISE_KT = 420;

/**
 * The speed to extrapolate across the remaining distance.
 *
 * WHY THIS EXISTS. The model above extrapolates the aircraft's CURRENT
 * groundspeed across everything past TERMINAL_NM. That is genuinely accurate
 * in cruise, which is where an aircraft spends most of a long flight -- but
 * it is badly wrong during climb-out, and wrong in proportion to how far the
 * aircraft still has to go. DAL1, JFK->LHR, read ~10h40 against a real ~7h:
 * ~2,940nm extrapolated at a climb-out 280kt is 10h30, while the same
 * distance at the ~490kt it would shortly be making is 6h. The aircraft was
 * never going to fly the Atlantic at 280 knots.
 *
 * So when an aircraft is demonstrably still climbing, below cruise altitude,
 * and already fast enough to be a jet, the current reading is treated as
 * unrepresentative and a nominal cruise speed is used instead. `Math.max`
 * rather than a plain substitution: a jet already faster than the nominal
 * keeps its own, better, number.
 *
 * ALL THREE GATES ARE REQUIRED, and each one is load-bearing:
 *   - climbing, or a cruising aircraft's real speed would be overridden;
 *   - below CRUISE_ALT_FT, or a step-climb at FL350 -- where groundspeed IS
 *     representative -- would be too;
 *   - and it must look like a jet: either already above JET_CLIMB_MIN_KT, or
 *     flying a leg at least JET_LEG_MIN_NM long. Without that last clause a
 *     piston twin would be projected to jet cruise and have its ETA more
 *     than halved; without the distance half of it, an airliner one minute
 *     off the runway is still too slow to recognise (see JET_LEG_MIN_NM).
 *
 * An unknown altitude or vertical rate means the gates cannot be evaluated,
 * so no correction is applied -- an absent value must not invent one, the
 * same rule the descent floor follows.
 */
function cruiseProjectionKt(
  distanceNm: number,
  groundspeedKt: number,
  altitudeFt?: number | null,
  verticalRateFpm?: number | null,
): number {
  if (altitudeFt == null || !Number.isFinite(altitudeFt)) return groundspeedKt;
  if (verticalRateFpm == null || !Number.isFinite(verticalRateFpm)) return groundspeedKt;
  if (verticalRateFpm < CLIMB_VS_FPM) return groundspeedKt;
  if (altitudeFt >= CRUISE_ALT_FT) return groundspeedKt;
  const isJet = groundspeedKt >= JET_CLIMB_MIN_KT || distanceNm >= JET_LEG_MIN_NM;
  if (!isJet) return groundspeedKt;
  return Math.max(groundspeedKt, NOMINAL_CRUISE_KT);
}

/**
 * Minutes remaining, or null if not estimable.
 *
 * Above TERMINAL_NM the aircraft's own groundspeed does the work — it is
 * genuinely accurate there. Below it groundspeed is already decaying, so the
 * nominal profile takes over and the current value is ignored. The halves meet
 * continuously at TERMINAL_MIN.
 *
 * `altitudeFt`, when supplied, adds a descent-time floor on top of that
 * horizontal figure: time remaining can never be less than the time needed to
 * lose the altitude at NOMINAL_DESCENT_FPM. This only ever pushes the answer
 * up, never down, and only binds when the aircraft is both high and
 * horizontally close -- an aircraft at cruise a stone's throw from its
 * destination coordinates, which is a real situation (holds, go-arounds,
 * overflights) and not evidence of an imminent landing. Altitude is optional
 * and, when missing or not a positive number, contributes no floor at all --
 * an unknown value must not invent a constraint.
 */
export function etaMinutes(
  distanceNm: number,
  groundspeedKt: number,
  altitudeFt?: number | null,
  verticalRateFpm?: number | null,
): number | null {
  if (!Number.isFinite(distanceNm) || distanceNm < 0) return null;

  let horizontal: number;
  if (distanceNm <= TERMINAL_NM) {
    horizontal = (distanceNm / TERMINAL_KT) * 60;
  } else {
    if (!Number.isFinite(groundspeedKt) || groundspeedKt <= 0) return null;
    const kt = cruiseProjectionKt(distanceNm, groundspeedKt, altitudeFt, verticalRateFpm);
    horizontal = ((distanceNm - TERMINAL_NM) / kt) * 60 + TERMINAL_MIN;
  }

  if (altitudeFt == null || !Number.isFinite(altitudeFt) || altitudeFt <= 0) return horizontal;
  const descentFloorMin = altitudeFt / NOMINAL_DESCENT_FPM;
  return Math.max(horizontal, descentFloorMin);
}

/**
 * Minutes remaining, at or below which LANDING may replace a numeric ETA.
 *
 * Derived, not hardcoded, the same way TERMINAL_MIN is: it is exactly the
 * horizontal-only ETA at LANDING_NM under the nominal terminal speed
 * (30nm / 200kt * 60 = 9min). That means an ordinary descent is completely
 * unaffected -- inside LANDING_NM, horizontal-only time is always at or under
 * this by construction, so nothing that used to say LANDING on geometry alone
 * stops saying it. It only starts to matter once etaMinutes' descent floor
 * pushes the estimate above it, which happens exactly when the aircraft is
 * too high to plausibly be seconds from touchdown -- the case this fix
 * exists for.
 */
export const LANDING_MAX_MIN = (LANDING_NM / TERMINAL_KT) * 60;

/**
 * Display string, or null to show nothing.
 *
 * LANDING requires BOTH being within LANDING_NM AND a genuinely small ETA
 * (<= LANDING_MAX_MIN). Proximity alone used to be sufficient, which is
 * exactly how a cruise-altitude aircraft horizontally near its destination
 * got reported as landing -- see etaMinutes' altitude floor, which is what
 * makes etaMin large in that case.
 *
 * A null etaMin means we could not estimate at all -- an absence of
 * information, not evidence of imminent arrival -- so it no longer defaults
 * to LANDING either; it shows nothing, the same as any other non-estimable
 * case.
 *
 * Rounded because the model does not support finer precision: it cannot know
 * about vectoring, holds, runway changes or taxi-in, so it lands within ~5 min
 * enroute and gets vaguer near the end. Always prefixed "~" so the panel never
 * implies a scheduled time.
 *
 * `clockDerived` opts out of that rounding, and ONLY a caller whose etaMin came
 * from a real arrival TIME may pass it -- AeroDataBox's revised or scheduled
 * arrival (enrich.ts), or a tracked entry's scheduled arrival (tracked/serve.ts).
 * Such a value is a countdown to a clock instant, so every minute that passes
 * takes a minute off it, and rounding to the nearest five made the panel LOOK
 * frozen: the number sat unchanged through five refreshes and then jumped by
 * five, which reads as a stale card rather than a coarse one. It is only the
 * PHYSICS estimate that cannot support minutes -- this file's own measurements
 * put it ~10 min optimistic at cruise -- and that path keeps its rounding
 * untouched. The "~" prefix stays either way: a scheduled arrival is still a
 * plan, not a promise, and the aircraft's own progress is not in this number.
 */
export function formatEta(
  distanceNm: number,
  etaMin: number | null,
  clockDerived = false,
): string | null {
  if (etaMin === null || !Number.isFinite(etaMin)) return null;
  if (Number.isFinite(distanceNm) && distanceNm <= LANDING_NM && etaMin <= LANDING_MAX_MIN) {
    return 'LANDING';
  }

  // One minute is the smallest step either branch below can take, so the floor
  // is 1 rather than 5 here -- but it is still a floor for the same reason:
  // outside LANDING_NM, "~0m" would be both wrong and alarming.
  const step = clockDerived ? 1 : 5;
  if (etaMin < 60) {
    const m = Math.max(step, Math.round(etaMin / step) * step);
    return m >= 60 ? '~1h00' : `~${m}m`;
  }
  const total = clockDerived ? Math.round(etaMin) : Math.round(etaMin / 10) * 10;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `~${h}h${String(m).padStart(2, '0')}`;
}
