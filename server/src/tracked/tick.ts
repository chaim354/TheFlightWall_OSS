import { decideTracked, type TrackedDecision } from './lifecycle';
import type { TrackedEntry } from './types';
import type { TrackedStorage } from './store';
import type { HexMatch } from './findHex';
import type { ResolveResult, RouteWant } from './resolve';
import type { PositionResult } from './opensky';

/**
 * Ceiling on AeroDataBox resolutions per day for this feature.
 *
 * 50, not a rounder number, because it must exceed what a legitimately full
 * store needs: MAX_ENTRIES (20) x 2 calls per journey is 40 in the worst case
 * where every entry resolves the same day, and a lower ceiling would deadlock
 * the cap against itself. It still leaves roughly 14 calls/day of the measured
 * spare untouched.
 */
export const DAILY_RESOLVE_CEILING = 50;

/**
 * How often any ONE airborne entry may be polled.
 *
 * The OpenSky spend used to be paced by the tick itself, which therefore had to
 * be 300s -- and that same 300s paced everything else the tick does, so a flight
 * added while already in the air waited up to five minutes to be resolved and up
 * to five more to be declared airborne, before the wall had even fetched. The
 * tick is now fast (TRACKED_TICK_MS in server.ts) and this is what keeps the
 * credit cost exactly where it was: each entry is still asked about at most once
 * per 300s, timed per entry from lastPollAtMs.
 *
 * FIX_FRESH_MS in serve.ts must still exceed this with margin; see there.
 */
export const POLL_INTERVAL_MS = 300_000;

/**
 * How many OpenSky polls may be in flight across any POLL_INTERVAL_MS window.
 *
 * THIS is the OpenSky guard, and it is a concurrency limit rather than a
 * store-size one. Only an airborne entry costs credits: a pending flight two
 * weeks out, or one that has landed, costs nothing at all. The entry cap used
 * to stand in for this, which made it far too blunt -- a calendar's worth of
 * travel is dozens of journeys spread over a fortnight with only a handful
 * ever in the air together, and capping the STORE punished the many for the
 * cost of the few.
 *
 * MEASURED: a single-icao24 query costs FOUR credits against an authenticated
 * allowance of 4000/day, so the real budget is ~1000 queries. At one poll per
 * POLL_INTERVAL_MS an eight-hour flight costs 96 of them, so ten concurrent is
 * 960 -- the honest ceiling, and why this is 10 rather than a rounder-feeling
 * number. Raising it means lengthening POLL_INTERVAL_MS by the same factor;
 * the two are one budget seen from opposite ends.
 *
 * Counted over the WINDOW, not per tick. With a 60s tick, "ten per tick" would
 * be fifty per five minutes -- the polls already made in the last window count
 * against it (see runTrackedTick), which is the old per-300s-tick limit exactly.
 *
 * Binding is a DEGRADATION, not a failure: an unpolled entry keeps its last
 * fix and stays airborne, so the card dead-reckons exactly as it already does
 * across an ocean gap. It is logged, because a wall quietly showing estimated
 * positions for everything would otherwise look like working live tracking.
 */
export const MAX_AIRBORNE_POLLS = 10;

/** Transport retries before an entry is declared unresolved. */
const MAX_ATTEMPTS = 3;

export interface TrackedDeps {
  /**
   * `want` names the leg, for a number that flies more than one that day. It
   * is a THIRD parameter rather than a change to the first two so every
   * existing implementation still satisfies this type -- TypeScript accepts a
   * function that ignores trailing arguments -- and one that ignores it simply
   * behaves as it did before routes could be requested.
   */
  resolve(number: string, date: string, want?: RouteWant): Promise<ResolveResult>;
  position(icao24: string): Promise<PositionResult>;
  resolvesUsedToday: number;
  /**
   * Sweep live ADS-B for whatever is broadcasting this flight number near
   * where the schedule says it should be. Optional so every TrackedDeps
   * literal that predates it still compiles; absent means the sweep is simply
   * not attempted and the entry follows the no-hex path as before.
   */
  findHex?(entry: TrackedEntry, nowMs: number): Promise<HexMatch | null>;
}

/**
 * One pass over every entry: ask the pure state machine what to do, then do it.
 *
 * All the branching lives in lifecycle.ts; this unit only performs actions and
 * writes results back. Keeping the split means the interesting rules are
 * testable without a network, and this file stays small enough to audit for the
 * one thing that matters on an unauthenticated feature -- that no path can call
 * AeroDataBox more than the ceiling allows.
 */
/**
 * Carry a decision's state onto an entry, stamping stateAtMs only on a change.
 *
 * The lifecycle's own reason travels with it when it has one. decideTracked can
 * declare an entry unresolved by itself -- an entry that resolved without a
 * departure time can never become airborne -- and that verdict arrives here
 * rather than from a failed API call, so the resolve branch never sees it.
 * Without this, GET /v1/tracked reports state 'unresolved' with reason null:
 * the user learns their flight is not being tracked but not why, which is the
 * one thing they need in order to fix it.
 */
function withDecision(e: TrackedEntry, d: TrackedDecision, nowMs: number): TrackedEntry {
  return d.state === e.state
    ? e
    : { ...e, state: d.state, stateAtMs: nowMs, reason: d.reason ?? e.reason };
}

/**
 * The store as it should be written, given what this tick read and what it
 * decided -- reconciled against what is in the store NOW.
 *
 * The store is read-whole-array / write-whole-array, and a tick holds its copy
 * across network awaits that can run for seconds. Writing `next` back blindly
 * would therefore erase any entry POSTed while the tick was out talking to
 * AeroDataBox or OpenSky, and resurrect any entry DELETEd meanwhile. With a
 * 300s tick that window was rare enough to go unnoticed; with a 60s tick, and a
 * pass kicked the moment an entry is added, it is exactly where a just-added
 * flight would land. So: entries this tick never saw are kept untouched,
 * entries removed by someone else stay removed, and only the entries this tick
 * actually read take this tick's version.
 */
export function reconcile(
  latest: TrackedEntry[],
  readAtStart: TrackedEntry[],
  next: TrackedEntry[],
): TrackedEntry[] {
  const seen = new Set(readAtStart.map((e) => e.id));
  const ours = new Map(next.map((e) => [e.id, e]));
  const out: TrackedEntry[] = [];
  for (const e of latest) {
    if (!seen.has(e.id)) out.push(e);
    else {
      const mine = ours.get(e.id);
      if (mine) out.push(mine);
      // else: this tick dropped it.
    }
  }
  return out;
}

/**
 * One pass over every entry: ask the pure state machine what to do, then do it.
 *
 * All the branching lives in lifecycle.ts; this unit only performs actions and
 * writes results back. Keeping the split means the interesting rules are
 * testable without a network, and this file stays small enough to audit for the
 * one thing that matters on an unauthenticated feature -- that no path can call
 * AeroDataBox more than the ceiling allows.
 *
 * Actions CHAIN within one pass: resolve, then -- re-deciding with what the
 * resolve returned -- the ADS-B sweep for a hex, then the first position poll.
 * A flight added while it is already in the air therefore goes from `pending`
 * to a servable card in the single pass that POST kicks off, instead of one
 * stage per tick. Each stage runs at most once, and a resolve never chains into
 * another resolve, so chaining adds no AeroDataBox call that a slower sequence
 * of ticks would not also have made.
 */
export async function runTrackedTick(
  storage: TrackedStorage,
  nowMs: number,
  deps: TrackedDeps,
): Promise<void> {
  const entries = await storage.read();
  if (entries.length === 0) return;

  let resolvesUsed = deps.resolvesUsedToday;
  // Polls already spent inside the current window count against the cap, so
  // the limit means what it meant when the tick WAS the window. See
  // MAX_AIRBORNE_POLLS.
  let polled = entries.filter(
    (e) =>
      e.state === 'airborne' &&
      e.lastPollAtMs != null &&
      nowMs - e.lastPollAtMs < POLL_INTERVAL_MS,
  ).length;
  let overBudgetLogged = false;
  const next: TrackedEntry[] = [];
  let changed = false;

  for (const e of entries) {
    const before = e.state;
    let d = decideTracked(e, nowMs);

    if (d.action === 'drop') {
      // Say so. This is the only path that makes an entry vanish, and a store
      // that silently reads empty is indistinguishable from one that was never
      // written to -- which is exactly how a bounds bug went unnoticed until a
      // person noticed the wall was not tracking anything: a local-dated
      // evening departure was swept by the date backstop 55 minutes before
      // pushback, from `pending`, leaving nothing behind to look at.
      //
      // The PRIOR STATE is the diagnostic half. "expired from landed" is the
      // feature working; "expired from pending", with a date that has not
      // departed yet, is a bug, and the two are one word apart in the log.
      console.log(
        `tracked: dropped ${e.number} ${e.date} -- expired from ${before}` +
          (e.reason ? ` (${e.reason})` : ''),
      );
      changed = true;
      continue;
    }

    let updated = withDecision(e, d, nowMs);
    if (d.state !== before) changed = true;

    if (d.action === 'resolve' || d.action === 'reresolve') {
      if (resolvesUsed >= DAILY_RESOLVE_CEILING) {
        console.error(
          `tracked: daily resolve ceiling (${DAILY_RESOLVE_CEILING}) reached; ${e.number} ${e.date} waits`,
        );
        next.push(updated);
        continue;
      }
      resolvesUsed++;
      const r = await deps.resolve(e.number, e.date, {
        origIata: e.wantOrigIata ?? null,
        destIata: e.wantDestIata ?? null,
      });
      changed = true;

      if (r.ok) {
        updated = {
          ...updated,
          ...r.flight,
          state: 'resolved',
          stateAtMs: nowMs,
          attempts: 0,
          reresolved: d.action === 'reresolve' ? true : updated.reresolved,
          reason: null,
        };
        // Re-decide with the answer. A flight that has already left goes
        // straight on to the sweep or the poll below, in this same pass.
        d = decideTracked(updated, nowMs);
        updated = withDecision(updated, d, nowMs);
      } else if (!r.retryable || updated.attempts >= MAX_ATTEMPTS) {
        // Terminal. A permanent miss is terminal immediately (attempts is
        // still 0 the first time through, but !r.retryable alone decides it).
        // A transport failure is terminal once MAX_ATTEMPTS prior failures are
        // already on record -- i.e. this call is the one after the budget was
        // spent -- so a single bad entry costs a bounded number of calls
        // rather than a retry loop forever. Comparing against the count
        // BEFORE this failure (not attempts + 1) matters: it is what lets the
        // entry actually use all MAX_ATTEMPTS retries before giving up,
        // instead of stopping one call short.
        updated = {
          ...updated,
          state: 'unresolved',
          stateAtMs: nowMs,
          attempts: updated.attempts + 1,
          reason: r.reason,
        };
        next.push(updated);
        continue;
      } else {
        updated = { ...updated, attempts: updated.attempts + 1 };
        next.push(updated);
        continue;
      }
    }

    if (d.action === 'findhex') {
      // Free and keyless (adsb.lol), so this is not metered like resolve --
      // but it is bounded anyway: decideTracked only asks while the flight
      // should still be in the air.
      //
      // A miss is NOT a failure. The aircraft may be outside receiver
      // coverage, or running late enough that the estimated position is wrong.
      // The entry stays resolved and the next tick sweeps again, so this makes
      // no state change and records no reason on an empty result.
      let found: HexMatch | null = null;
      try {
        found = deps.findHex ? await deps.findHex(updated, nowMs) : null;
      } catch (err) {
        // One flight's sweep failing must not take the tick down with it --
        // the entries after this one still need their positions polled.
        console.error(
          `tracked: hex sweep failed for ${e.number} ${e.date}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!found) {
        next.push(updated);
        continue;
      }
      changed = true;
      console.log(`tracked: ${e.number} ${e.date} is flying as ${found.callsign} (${found.hex})`);
      updated = {
        ...updated,
        icao24: found.hex,
        // Take the callsign, registration and type too: the entry had none
        // of them (that is why it needed this), and the panel derives the
        // operator and its logo tile from the callsign's first three
        // letters. Without it a pinned card renders with no logo at all.
        callsign: updated.callsign ?? found.callsign,
        reg: updated.reg ?? found.registration,
        aircraftType: updated.aircraftType ?? found.typeIcao,
      };
      // Re-decide now that there IS a hex, and carry on to the first poll
      // below rather than leaving it for the next tick.
      d = decideTracked(updated, nowMs);
      updated = withDecision(updated, d, nowMs);
    }

    if (d.action === 'poll' && updated.icao24) {
      // Not due: this entry was asked about inside the last POLL_INTERVAL_MS.
      // The tick runs far more often than an entry is polled, so this is the
      // common case and costs nothing -- the card serves the last fix.
      if (updated.lastPollAtMs != null && nowMs - updated.lastPollAtMs < POLL_INTERVAL_MS) {
        next.push(updated);
        continue;
      }
      if (polled >= MAX_AIRBORNE_POLLS) {
        // Keep the entry exactly as it is: still airborne, still holding its
        // last fix, so serve.ts dead-reckons from it rather than dropping the
        // card. Logged per tick, not per entry, so a busy sky says so once.
        if (!overBudgetLogged) {
          overBudgetLogged = true;
          console.error(
            `tracked: more than ${MAX_AIRBORNE_POLLS} airborne; the rest dead-reckon this tick`,
          );
        }
        next.push(updated);
        continue;
      }
      polled++;
      const p = await deps.position(updated.icao24);
      changed = true;
      // Stamped whatever came back: an empty answer is still a spent query.
      updated = { ...updated, lastPollAtMs: nowMs };
      if (p.ok && p.position) {
        // Re-run the machine with the observation, so an early arrival lands
        // the flight now instead of burning credits until schedule+grace.
        const withObs = decideTracked(updated, nowMs, p.position.onGround);
        updated = {
          ...updated,
          state: withObs.state,
          stateAtMs: withObs.state === updated.state ? updated.stateAtMs : nowMs,
          lastLat: p.position.lat,
          lastLon: p.position.lon,
          lastPosAtMs: nowMs,
          // Stored alongside the position, from the same poll -- serve.ts
          // reads these straight through onto the card. A card blanked
          // altitude/speed/heading/vs entirely until this wiring existed;
          // see serve.ts's own comment on trackedCards for the user-visible
          // half of that bug.
          lastAltFt: p.position.altitudeFt,
          lastGroundspeedKt: p.position.groundspeedKt,
          lastHeadingDeg: p.position.headingDeg,
          lastVerticalRateFpm: p.position.verticalRateFpm,
        };
      }
      // p.position === null is the ocean gap: leave the entry airborne and let
      // the serving layer dead-reckon. Not an error, and not a landing.
    }

    next.push(updated);
  }

  if (changed) await storage.write(reconcile(await storage.read(), entries, next));
}
