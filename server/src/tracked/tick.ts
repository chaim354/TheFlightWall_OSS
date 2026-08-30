import { decideTracked } from './lifecycle';
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
 * How many AIRBORNE entries may be polled in one tick.
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
 * allowance of 4000/day, so the real budget is ~1000 queries. At the 300s tick
 * an eight-hour flight costs 96 of them, so ten concurrent is 960 -- the
 * honest ceiling, and why this is 10 rather than a rounder-feeling number.
 * Raising it means lengthening TRACKED_TICK_MS in server.ts by the same
 * factor; the two are one budget seen from opposite ends.
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
export async function runTrackedTick(
  storage: TrackedStorage,
  nowMs: number,
  deps: TrackedDeps,
): Promise<void> {
  const entries = await storage.read();
  if (entries.length === 0) return;

  let resolvesUsed = deps.resolvesUsedToday;
  let polled = 0;
  let overBudgetLogged = false;
  const next: TrackedEntry[] = [];
  let changed = false;

  for (const e of entries) {
    const before = e.state;
    const d = decideTracked(e, nowMs);

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

    // Carry the lifecycle's own reason across when it has one. decideTracked can
    // declare an entry unresolved by itself -- an entry that resolved without a
    // departure time can never become airborne -- and that verdict arrives here
    // rather than from a failed API call, so the resolve branch below never sees
    // it. Without this, GET /v1/tracked reports state 'unresolved' with reason
    // null: the user learns their flight is not being tracked but not why, which
    // is the one thing they need in order to fix it.
    let updated: TrackedEntry =
      d.state === before
        ? e
        : { ...e, state: d.state, stateAtMs: nowMs, reason: d.reason ?? e.reason };
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
      } else {
        updated = { ...updated, attempts: updated.attempts + 1 };
      }
    } else if (d.action === 'findhex') {
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
      if (found) {
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
        // Re-decide now that there IS a hex. Without this the entry sits in
        // `resolved` for a whole extra tick before anything notices, which on
        // a 300s interval is five minutes of a flight that is already in the
        // air and now trackable. The poll branch below re-runs the machine
        // with its observation for the same reason.
        const withHex = decideTracked(updated, nowMs);
        updated = {
          ...updated,
          state: withHex.state,
          stateAtMs: withHex.state === updated.state ? updated.stateAtMs : nowMs,
        };
      }
      next.push(updated);
      continue;
    } else if (d.action === 'poll' && updated.icao24) {
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

  if (changed) await storage.write(next);
}
