import type { TrackedEntry, TrackedAction, TrackedState } from './types';

/** Re-resolve this long before scheduled departure, to catch a tail swap. */
const RERESOLVE_LEAD_MS = 60 * 60_000;
/** How long after scheduled arrival to keep polling when nothing says landed. */
const ARRIVAL_GRACE_MS = 30 * 60_000;
/** Terminal-state expiry timers. */
const EXPIRE_AFTER_LANDED_MS = 2 * 60 * 60_000;
const EXPIRE_AFTER_UNRESOLVED_MS = 24 * 60 * 60_000;
/**
 * Absolute cap on how long an entry may stay airborne when we have a departure
 * time but no arrival time. The longest scheduled commercial flight is about
 * 19h, so 20h cannot cut a real journey short while still bounding an entry
 * that would otherwise poll OpenSky forever.
 */
const MAX_AIRBORNE_MS = 20 * 60 * 60_000;
/** Backstop for an entry stuck in a non-terminal state by a bug. */
const EXPIRE_AFTER_DATE_MS = 24 * 60 * 60_000;

export interface TrackedDecision {
  state: TrackedState;
  action: TrackedAction;
  /**
   * Set when this decision moves an entry straight to `unresolved` on its
   * own, as opposed to a resolve/reresolve attempt failing -- that path is
   * driven by tick.ts, which records its own reason from the resolve result
   * and does not read this field.
   */
  reason?: string;
}

/**
 * Midnight UTC for an ISO "YYYY-MM-DD", or NaN if it is not one.
 *
 * Strict on purpose. `new Date("14/09/2026")` is an Invalid Date in some
 * engines and a real date in others, and a date that silently became the wrong
 * day would resolve the wrong flight and spend a call doing it.
 */
export function startOfUtcDay(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * The whole lifecycle, as a pure function.
 *
 * Takes the observed on-ground flag as a PARAMETER rather than reading it, so
 * this stays testable without a network and the caller keeps the one job of
 * performing the action it is told to perform. `onGround` is null when we have
 * no observation this tick -- which is not the same as "airborne", and
 * conflating the two would land a flight every time ADS-B coverage dropped.
 */
export function decideTracked(
  e: TrackedEntry,
  nowMs: number,
  onGround: boolean | null = null,
): TrackedDecision {
  if (e.state === 'expired') return { state: 'expired', action: 'drop' };

  if (e.state === 'landed') {
    return nowMs - e.stateAtMs >= EXPIRE_AFTER_LANDED_MS
      ? { state: 'expired', action: 'drop' }
      : { state: 'landed', action: 'none' };
  }

  if (e.state === 'unresolved') {
    return nowMs - e.stateAtMs >= EXPIRE_AFTER_UNRESOLVED_MS
      ? { state: 'expired', action: 'drop' }
      : { state: 'unresolved', action: 'none' };
  }

  // Backstop before anything schedule-driven: a pending/resolved entry whose
  // date is well past has nothing left to do regardless of the state it is
  // stuck in. Airborne is exempt -- it already has its own tighter, correct
  // bound below (scheduled arrival plus grace, then EXPIRE_AFTER_LANDED_MS
  // once landed), and a late-departing long-haul flight can legitimately
  // still be airborne more than a day after its date's UTC midnight.
  const dayStart = startOfUtcDay(e.date);
  // Exempt `airborne` from the DATE backstop only when it has flight times of
  // its own to be bounded by. An 18:00Z departure on a 7h leg lands at 01:00Z
  // the next day, so a backstop keyed on the entry date's midnight would drop
  // it in mid-air -- the normal case for a worldwide tracker, not an edge one.
  // With no times at all there is nothing else to bound it, so the backstop
  // must still apply or the entry polls forever.
  const airborneHasTimes =
    e.state === 'airborne' && (e.schedDepEpoch !== null || e.schedArrEpoch !== null);
  if (!airborneHasTimes && !Number.isNaN(dayStart) && nowMs >= dayStart + EXPIRE_AFTER_DATE_MS) {
    return { state: 'expired', action: 'drop' };
  }

  if (e.state === 'pending') {
    if (Number.isNaN(dayStart)) return { state: 'pending', action: 'none' };
    return nowMs >= dayStart
      ? { state: 'pending', action: 'resolve' }
      : { state: 'pending', action: 'none' };
  }

  const depMs = e.schedDepEpoch === null ? null : e.schedDepEpoch * 1000;
  const arrMs = e.schedArrEpoch === null ? null : e.schedArrEpoch * 1000;

  if (e.state === 'resolved') {
    if (depMs === null) {
      // Without a departure time this entry can never reach `depMs >=
      // nowMs` below, so it would otherwise sit as `resolved`/`none` forever
      // -- doing nothing and telling nobody -- until the date backstop above
      // finally swept it a day later. Bug 1's fix (leg selection in
      // resolve.ts) should keep this from arising, but an entry that cannot
      // progress must never sit inert regardless of why it got here, so this
      // is terminal immediately, with a reason that surfaces on
      // GET /v1/tracked instead of failing silently.
      return { state: 'unresolved', action: 'none', reason: 'resolved without a departure time' };
    }
    if (nowMs >= depMs) {
      // Nothing to poll without a hex; going airborne would guarantee an empty
      // call every tick for the length of the flight.
      return e.icao24
        ? { state: 'airborne', action: 'poll' }
        : { state: 'resolved', action: 'none' };
    }
    if (!e.reresolved && nowMs >= depMs - RERESOLVE_LEAD_MS) {
      return { state: 'resolved', action: 'reresolve' };
    }
    return { state: 'resolved', action: 'none' };
  }

  // airborne
  // Bounded on three paths, because each alone leaves a hole: the on-ground
  // observation when ADS-B gives us one; scheduled arrival plus grace when we
  // have an arrival time; and departure plus MAX_AIRBORNE_MS when we do not.
  // The date backstop above covers the remaining case of no times at all.
  if (onGround === true) return { state: 'landed', action: 'none' };
  if (arrMs !== null && nowMs >= arrMs + ARRIVAL_GRACE_MS) {
    return { state: 'landed', action: 'none' };
  }
  if (arrMs === null && depMs !== null && nowMs >= depMs + MAX_AIRBORNE_MS) {
    return { state: 'landed', action: 'none' };
  }
  return { state: 'airborne', action: 'poll' };
}
