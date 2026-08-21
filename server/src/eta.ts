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
): number | null {
  if (!Number.isFinite(distanceNm) || distanceNm < 0) return null;

  let horizontal: number;
  if (distanceNm <= TERMINAL_NM) {
    horizontal = (distanceNm / TERMINAL_KT) * 60;
  } else {
    if (!Number.isFinite(groundspeedKt) || groundspeedKt <= 0) return null;
    horizontal = ((distanceNm - TERMINAL_NM) / groundspeedKt) * 60 + TERMINAL_MIN;
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
 */
export function formatEta(distanceNm: number, etaMin: number | null): string | null {
  if (etaMin === null || !Number.isFinite(etaMin)) return null;
  if (Number.isFinite(distanceNm) && distanceNm <= LANDING_NM && etaMin <= LANDING_MAX_MIN) {
    return 'LANDING';
  }

  if (etaMin < 60) {
    // Nearest 5, but never round down to a bare zero — outside LANDING_NM,
    // "~0m" would be both wrong and alarming.
    const m = Math.max(5, Math.round(etaMin / 5) * 5);
    return m >= 60 ? '~1h00' : `~${m}m`;
  }
  const total = Math.round(etaMin / 10) * 10;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `~${h}h${String(m).padStart(2, '0')}`;
}
