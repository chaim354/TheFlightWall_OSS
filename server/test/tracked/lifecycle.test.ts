import { describe, it, expect } from 'vitest';
import { decideTracked, startOfUtcDay } from '../../src/tracked/lifecycle';
import type { TrackedEntry } from '../../src/tracked/types';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A pending entry for 2026-09-14 with nothing resolved yet. */
function entry(over: Partial<TrackedEntry> = {}): TrackedEntry {
  return {
    id: 'e1',
    number: 'BA181',
    date: '2026-09-14',
    wantOrigIata: null,
    wantDestIata: null,
    state: 'pending',
    reason: null,
    attempts: 0,
    stateAtMs: 0,
    reresolved: false,
    source: 'manual',
    icao24: null,
    callsign: null,
    reg: null,
    aircraftModel: null,
    aircraftType: null,
    origIata: null,
    destIata: null,
    orig: null,
    dest: null,
    schedDepEpoch: null,
    schedArrEpoch: null,
    lastLat: null,
    lastLon: null,
    lastPosAtMs: null,
    lastAltFt: null,
    lastGroundspeedKt: null,
    lastHeadingDeg: null,
    lastVerticalRateFpm: null,
    ...over,
  };
}

const DAY_START = Date.UTC(2026, 8, 14, 0, 0, 0); // month is 0-based

describe('startOfUtcDay', () => {
  it('returns midnight UTC for an ISO date', () => {
    expect(startOfUtcDay('2026-09-14')).toBe(DAY_START);
  });

  it('returns NaN for a malformed date rather than guessing', () => {
    expect(Number.isNaN(startOfUtcDay('14/09/2026'))).toBe(true);
    expect(Number.isNaN(startOfUtcDay('nonsense'))).toBe(true);
  });
});

describe('decideTracked - pending', () => {
  const TZ_LEAD = 14 * 60 * 60_000;

  it('does nothing before the entry date can have begun anywhere on earth', () => {
    const d = decideTracked(entry(), DAY_START - TZ_LEAD - 1);
    expect(d).toEqual({ state: 'pending', action: 'none' });
  });

  it('resolves once the entry date begins', () => {
    // The spec said "3h before departure"; departure is unknown while pending,
    // so the trigger is the start of the date itself.
    const d = decideTracked(entry(), DAY_START);
    expect(d).toEqual({ state: 'pending', action: 'resolve' });
  });

  it('resolves BEFORE 00:00 UTC, because the date is local to the departure airport', () => {
    // The regression this guards: `date` is the calendar date at the departure
    // airport, so a 07:00 departure from Tokyo on the 25th is 22:00Z on the
    // 24th. A trigger keyed on 00:00Z of the 25th fires two hours after the
    // aircraft has left. 14h of lead covers UTC+14, the largest real offset.
    expect(decideTracked(entry(), DAY_START - TZ_LEAD)).toEqual({
      state: 'pending', action: 'resolve',
    });
    // Tokyo's own local midnight, 15:00Z the day before, is comfortably inside.
    expect(decideTracked(entry(), DAY_START - 9 * 60 * 60_000)).toEqual({
      state: 'pending', action: 'resolve',
    });
  });
});

describe('decideTracked - resolved', () => {
  const dep = DAY_START + 18 * HOUR;
  const arr = dep + 7 * HOUR;
  const resolved = (over: Partial<TrackedEntry> = {}) =>
    entry({ state: 'resolved', schedDepEpoch: dep / 1000, schedArrEpoch: arr / 1000, icao24: '4008f3', ...over });

  it('waits while departure is more than an hour away', () => {
    expect(decideTracked(resolved(), dep - HOUR - 1)).toEqual({ state: 'resolved', action: 'none' });
  });

  it('re-resolves exactly once, an hour before departure', () => {
    expect(decideTracked(resolved(), dep - HOUR)).toEqual({ state: 'resolved', action: 'reresolve' });
    // Already done: must not ask again, or every tick burns a call.
    expect(decideTracked(resolved({ reresolved: true }), dep - HOUR)).toEqual({
      state: 'resolved',
      action: 'none',
    });
  });

  it('becomes airborne at scheduled departure and starts polling', () => {
    expect(decideTracked(resolved({ reresolved: true }), dep)).toEqual({ state: 'airborne', action: 'poll' });
  });

  it('does not go airborne without a hex to poll, and says so instead of sitting inert', () => {
    // Nothing to ask OpenSky about, so it must not go airborne -- polling
    // would be a guaranteed-empty call every tick for the length of a flight.
    //
    // But it must not sit in `resolved`/`none` either, which is what it used
    // to do. MEASURED 2026-08-25: AA3964 ORD->HPN resolved with a route and
    // schedule but NO modeS hex, and parked silently -- nothing on the wall
    // and nothing anywhere saying why -- until the 24h date backstop would
    // have swept it. Past departure there is no route to a hex at all: the
    // reresolve branch below is unreachable once `nowMs >= depMs`.
    //
    // Terminal with a reason, for exactly the argument the depMs === null
    // case makes four lines earlier: an entry that cannot progress must never
    // fail silently.
    expect(decideTracked(resolved({ reresolved: true, icao24: null }), dep)).toEqual({
      state: 'unresolved',
      action: 'none',
      reason: 'resolved without an aircraft to follow (no Mode S hex)',
    });
  });

  it('still re-resolves a hexless entry BEFORE departure, where a hex can still arrive', () => {
    // The pre-departure path must keep working: an aircraft is often assigned
    // late, and the re-resolve an hour out is what picks it up. Only the
    // past-departure case is terminal.
    expect(decideTracked(resolved({ reresolved: false, icao24: null }), dep - HOUR)).toEqual({
      state: 'resolved',
      action: 'reresolve',
    });
  });

  it('becomes unresolved, with a reason, rather than sitting inert with no departure time', () => {
    // Bug: an entry that resolved without a departure time could never reach
    // `airborne` (the `depMs === null` guard just kept returning
    // resolved/none), so it sat doing nothing and telling nobody until the
    // 24h date backstop silently expired it a day later. It must instead
    // become terminal `unresolved` immediately, with a reason, so it surfaces
    // on GET /v1/tracked.
    const e = resolved({ schedDepEpoch: null, stateAtMs: DAY_START });
    const d = decideTracked(e, DAY_START + HOUR);
    expect(d.state).toBe('unresolved');
    expect(d.state).not.toBe('resolved');
    expect(d.reason).toBe('resolved without a departure time');
  });
});

describe('decideTracked - the date backstop against a local date', () => {
  // REGRESSION, observed in production. `date` is the calendar date at the
  // DEPARTURE AIRPORT, so west of Greenwich it both starts and ENDS after
  // 00:00 UTC -- at UTC-12 the date runs to 12:00Z the following day.
  //
  // DL1732 was added on the evening of the 24th in New York for local date
  // 2026-08-24, departing 00:55Z on the 25th. Keyed on dayStart + 24h alone,
  // the backstop fired at 00:00Z on the 25th, 55 minutes BEFORE pushback: the
  // first tick after the entry was stored swept it as expired and dropped it,
  // and the store just read empty with nothing saying why.
  const HOURS = (n: number) => n * HOUR;

  it('does NOT expire a pending entry whose local date has not departed yet', () => {
    // 02:00Z on the 25th -- the moment the real entry was killed.
    expect(decideTracked(entry(), DAY_START + HOURS(26))).toEqual({
      state: 'pending', action: 'resolve',
    });
    // and right up to the end of the date at UTC-12, plus its 24h of grace
    expect(decideTracked(entry(), DAY_START + HOURS(35)).state).not.toBe('expired');
  });

  it('still expires an entry once even UTC-12 has run out of date', () => {
    expect(decideTracked(entry(), DAY_START + HOURS(37))).toEqual({
      state: 'expired', action: 'drop',
    });
  });
});

describe('decideTracked - airborne', () => {
  const dep = DAY_START + 18 * HOUR;
  const arr = dep + 7 * HOUR;
  const flying = (over: Partial<TrackedEntry> = {}) =>
    entry({ state: 'airborne', schedDepEpoch: dep / 1000, schedArrEpoch: arr / 1000, icao24: '4008f3', reresolved: true, ...over });

  it('keeps polling while en route', () => {
    expect(decideTracked(flying(), dep + HOUR)).toEqual({ state: 'airborne', action: 'poll' });
  });

  it('lands immediately when OpenSky reports on-ground, before the schedule says so', () => {
    // An early arrival must not keep burning OpenSky credits for an hour.
    expect(decideTracked(flying(), dep + HOUR, true)).toEqual({ state: 'landed', action: 'none' });
  });

  it('lands on schedule plus grace when no on-ground signal arrives', () => {
    // Grace exists because delays are normal and ADS-B coverage at the
    // destination is not guaranteed.
    expect(decideTracked(flying(), arr + 30 * 60_000 - 1)).toEqual({ state: 'airborne', action: 'poll' });
    expect(decideTracked(flying(), arr + 30 * 60_000)).toEqual({ state: 'landed', action: 'none' });
  });
});

describe('decideTracked - airborne is bounded on every path', () => {
  const dep = DAY_START + 18 * HOUR;
  const flying = (over: Partial<TrackedEntry> = {}) =>
    entry({ state: 'airborne', schedDepEpoch: dep / 1000, icao24: '406947', reresolved: true, ...over });

  it('keeps polling an evening long-haul across UTC midnight', () => {
    // Regression. An 18:00Z departure with a 7h flight lands at 01:00Z the NEXT
    // day, so a backstop keyed on the entry date's midnight would drop it in
    // mid-air. For a worldwide tracker that is the normal case, not an edge one.
    const arr = dep + 7 * HOUR; // 01:00Z next day, past dayStart + 24h
    const e = flying({ schedArrEpoch: arr / 1000 });
    expect(decideTracked(e, DAY_START + 24 * HOUR + 1)).toEqual({ state: 'airborne', action: 'poll' });
    expect(decideTracked(e, arr + 30 * 60_000)).toEqual({ state: 'landed', action: 'none' });
  });

  it('lands an entry with NO arrival time after a maximum airborne duration', () => {
    // Without this, an entry resolved with a departure but no arrival polls
    // OpenSky forever. Nothing else bounds it -- and unbounded polling is the
    // exact quota drain the guards exist to prevent.
    const e = flying({ schedArrEpoch: null });
    expect(decideTracked(e, dep + 19 * HOUR)).toEqual({ state: 'airborne', action: 'poll' });
    expect(decideTracked(e, dep + 20 * HOUR)).toEqual({ state: 'landed', action: 'none' });
  });

  it('expires an airborne entry that has no usable times at all', () => {
    const e = flying({ schedDepEpoch: null, schedArrEpoch: null });
    expect(decideTracked(e, DAY_START + 2 * DAY)).toEqual({ state: 'expired', action: 'drop' });
  });
});

describe('decideTracked - terminal states expire', () => {
  it('drops a landed entry two hours later', () => {
    const e = entry({ state: 'landed', stateAtMs: DAY_START });
    expect(decideTracked(e, DAY_START + 2 * HOUR - 1)).toEqual({ state: 'landed', action: 'none' });
    expect(decideTracked(e, DAY_START + 2 * HOUR)).toEqual({ state: 'expired', action: 'drop' });
  });

  it('drops an unresolved entry a day later, and never retries it', () => {
    // Terminal on purpose: a typo must cost a bounded number of calls, not a
    // retry loop against an endpoint that will never succeed.
    const e = entry({ state: 'unresolved', reason: 'not operating', stateAtMs: DAY_START });
    expect(decideTracked(e, DAY_START + DAY - 1)).toEqual({ state: 'unresolved', action: 'none' });
    expect(decideTracked(e, DAY_START + DAY)).toEqual({ state: 'expired', action: 'drop' });
  });

  it('drops anything whose date is more than a day past, whatever its state', () => {
    // Backstop: covers an entry stuck in a non-terminal state by a bug.
    const e = entry({ state: 'resolved', schedDepEpoch: null });
    expect(decideTracked(e, DAY_START + 2 * DAY)).toEqual({ state: 'expired', action: 'drop' });
  });

  it('an expired entry always asks to be dropped', () => {
    expect(decideTracked(entry({ state: 'expired' }), DAY_START)).toEqual({ state: 'expired', action: 'drop' });
  });
});

describe('hexless past departure: sweep live ADS-B before giving up', () => {
  // Local to this block; the `dep` above belongs to another describe.
  const dep = DAY_START + 18 * HOUR;
  // AeroDataBox has no aircraft for many regional flights, so the entry
  // resolves with a route and nothing to poll. Rather than declaring it dead,
  // ask live ADS-B where the flight number is -- see findHex.ts for why the
  // digits are the only derivable link from AA3964 to ENY3964.
  const withRoute = (over = {}) =>
    entry({
      state: 'resolved', icao24: null, reresolved: true,
      schedDepEpoch: dep / 1000, schedArrEpoch: (dep + 3 * HOUR) / 1000,
      orig: { lat: 41.067, lon: -73.7076 }, dest: { lat: 41.9786, lon: -87.9048 },
      ...over,
    });

  it('asks ADS-B for the hex once the flight should be airborne', () => {
    expect(decideTracked(withRoute(), dep + 5 * 60_000)).toEqual({
      state: 'resolved',
      action: 'findhex',
    });
  });

  it('gives up with a reason once the flight should have landed', () => {
    // Past arrival there is nothing left to find in the air, so this stops
    // sweeping rather than searching an empty sky until the date backstop.
    expect(decideTracked(withRoute(), dep + 4 * HOUR)).toEqual({
      state: 'unresolved',
      action: 'none',
      reason: 'no aircraft broadcasting this flight number could be found',
    });
  });

  it('does not sweep without a route to estimate a position from', () => {
    // searchCentre needs both ends and both times; half a route gives a
    // position worse than no position, so there is nothing to search near.
    expect(decideTracked(withRoute({ dest: null }), dep + 5 * 60_000)).toEqual({
      state: 'unresolved',
      action: 'none',
      reason: 'resolved without an aircraft to follow (no Mode S hex)',
    });
  });

  it('polls normally the moment a hex is known', () => {
    expect(decideTracked(withRoute({ icao24: '4008f3' }), dep + 5 * 60_000)).toEqual({
      state: 'airborne',
      action: 'poll',
    });
  });
});
