/**
 * Quiet-hours gating for the schedule refresh timer.
 *
 * The device now stops fetching positions while its panel is dark, and that
 * silences adsb.lol for free because position fetching happens per incoming
 * request. The schedule refresh does not follow: it is a `setInterval` in
 * server.ts that keeps ticking through the night regardless of whether any
 * panel is awake to see the result, and every tick costs against
 * AeroDataBox's metered plan (see TWO_HOURS_MS in server.ts). This module is
 * what gives the timer a night to skip: pure predicates over an hour and a
 * clock, with no I/O and no knowledge of the timer that calls them.
 *
 * WHY THE WINDOW MUST END BEFORE THE PANEL WAKES. server.ts documents that
 * one refresh covers roughly +/-6h centred on the moment the table was BUILT,
 * and that coverage is spent by the end of each cycle -- a table built at
 * 23:00 covers ~17:00-05:00 and has nothing for a 07:00 departure. A quiet
 * window that runs past the panel's actual wake time would hand the panel a
 * table that is already blind to the morning by the time anyone is watching
 * it. The window is the operator's to set (see parseQuietHours), but it has
 * to end at or before the panel starts asking for positions again, or the
 * quiet hours meant to save calls end up costing the first hour of viewing.
 *
 * WHY LEAVING QUIET HOURS FORCES AN IMMEDIATE REFRESH. The refresh timer is a
 * plain `setInterval`, which runs on whatever phase it happened to start at
 * -- it has no idea when quiet hours end. Left alone, the first tick after
 * quiet hours end could land anywhere up to a full interval later (up to ~2h
 * at the current cadence), which stacks on top of the +/-6h budget above and
 * could leave the table cold for the entire first morning. shouldRefresh
 * closes that gap by comparing this check against the previous one
 * (`wasQuiet`) and forcing a refresh the moment `quiet` goes from true to
 * false, independent of how much of the interval has elapsed. That only
 * works if it is actually called often enough to catch the transition
 * promptly -- callers are expected to run it on a short, fixed cadence (every
 * few minutes), not on the refresh interval itself, which is exactly the
 * phase problem this exists to route around.
 */

/** An hour-of-day window. `startHour` is inclusive, `endHour` is exclusive. */
export interface QuietWindow {
  startHour: number;
  endHour: number;
}

/** Matches "H-H" or "HH-HH"; range and zero-width checks happen after. */
const WINDOW_RE = /^(\d{1,2})-(\d{1,2})$/;

/**
 * Parses a "START-END" hour window (e.g. "23-7"), or null if quiet hours are
 * disabled or the input cannot be trusted.
 *
 * Undefined, empty, and "off" all mean disabled -- an unset env var must not
 * be mistaken for a misconfigured one. Anything else that fails to parse
 * cleanly returns null rather than falling back to some guessed default:
 * a typo here (a stray character, a copy-pasted "0-24") must not silently
 * become a window that suppresses refreshes all day, because that failure
 * mode looks identical to an upstream outage from the schedule table's side
 * and is far harder to notice than a rejected config would be.
 */
export function parseQuietHours(raw: string | undefined): QuietWindow | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'off') return null;

  const m = WINDOW_RE.exec(trimmed);
  if (!m) return null;

  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  // The regex already rules out negatives (\d matches digits only); only the
  // upper bound needs checking here.
  if (startHour > 23 || endHour > 23) return null;
  // A window of width zero is a typo (e.g. a duplicated hour), not a request
  // for 24h of quiet -- an all-day window disables the refresh entirely, and
  // that should require saying so explicitly, not follow from a slip.
  if (startHour === endHour) return null;

  return { startHour, endHour };
}

/**
 * Whether `hour` (0-23) falls inside quiet window `w`.
 *
 * Handles windows that wrap midnight (e.g. 23-7, quiet overnight): when
 * `startHour` is not before `endHour`, the window is read as running from
 * `startHour` to 23 and again from 0 up to `endHour`, rather than as an
 * ordinary same-day range that would otherwise come out empty.
 */
export function inQuietHours(hour: number, w: QuietWindow): boolean {
  if (w.startHour <= w.endHour) {
    return hour >= w.startHour && hour < w.endHour;
  }
  return hour >= w.startHour || hour < w.endHour;
}

/** Everything shouldRefresh needs, gathered by the caller each time it polls. */
export interface RefreshCheck {
  /** Current time. */
  nowMs: number;
  /** When the schedule last actually refreshed, or null if it never has. */
  lastRefreshMs: number | null;
  /** The ordinary refresh cadence (e.g. TWO_HOURS_MS in server.ts). */
  intervalMs: number;
  /** Whether `nowMs` falls inside quiet hours. */
  quiet: boolean;
  /** Whether the PREVIOUS check (one polling tick ago) was quiet. */
  wasQuiet: boolean;
}

/**
 * Whether the schedule should refresh right now.
 *
 * In priority order: never while quiet; always on the tick that finds quiet
 * hours just ended, whatever the interval says (see the module doc); always
 * if nothing has ever been fetched; otherwise only once a full interval has
 * elapsed since the last refresh.
 */
export function shouldRefresh(c: RefreshCheck): boolean {
  if (c.quiet) return false;
  if (c.wasQuiet) return true;
  if (c.lastRefreshMs === null) return true;
  return c.nowMs - c.lastRefreshMs >= c.intervalMs;
}
