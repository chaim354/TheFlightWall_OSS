// Pure ETA model. No I/O.
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
 * Minutes remaining, or null if not estimable.
 *
 * Above TERMINAL_NM the aircraft's own groundspeed does the work — it is
 * genuinely accurate there. Below it groundspeed is already decaying, so the
 * nominal profile takes over and the current value is ignored. The halves meet
 * continuously at TERMINAL_MIN.
 */
export function etaMinutes(distanceNm: number, groundspeedKt: number): number | null {
  if (!Number.isFinite(distanceNm) || distanceNm < 0) return null;
  if (distanceNm <= TERMINAL_NM) return (distanceNm / TERMINAL_KT) * 60;
  if (!Number.isFinite(groundspeedKt) || groundspeedKt <= 0) return null;
  return ((distanceNm - TERMINAL_NM) / groundspeedKt) * 60 + TERMINAL_MIN;
}

/**
 * Display string, or null to show nothing.
 *
 * Rounded because the model does not support finer precision: it cannot know
 * about vectoring, holds, runway changes or taxi-in, so it lands within ~5 min
 * enroute and gets vaguer near the end. Always prefixed "~" so the panel never
 * implies a scheduled time.
 */
export function formatEta(distanceNm: number, etaMin: number | null): string | null {
  if (Number.isFinite(distanceNm) && distanceNm <= LANDING_NM) return 'LANDING';
  if (etaMin === null || !Number.isFinite(etaMin)) return null;

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
