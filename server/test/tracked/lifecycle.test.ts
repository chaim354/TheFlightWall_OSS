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
    state: 'pending',
    reason: null,
    attempts: 0,
    stateAtMs: 0,
    reresolved: false,
    icao24: null,
    reg: null,
    origIata: null,
    destIata: null,
    orig: null,
    dest: null,
    schedDepEpoch: null,
    schedArrEpoch: null,
    lastLat: null,
    lastLon: null,
    lastPosAtMs: null,
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
  it('does nothing before the entry date begins', () => {
    const d = decideTracked(entry(), DAY_START - 1);
    expect(d).toEqual({ state: 'pending', action: 'none' });
  });

  it('resolves once the entry date begins', () => {
    // The spec said "3h before departure"; departure is unknown while pending,
    // so the trigger is the start of the date itself.
    const d = decideTracked(entry(), DAY_START);
    expect(d).toEqual({ state: 'pending', action: 'resolve' });
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

  it('does not go airborne without a hex to poll', () => {
    // Nothing to ask OpenSky about. Polling would be a guaranteed-empty call.
    expect(decideTracked(resolved({ reresolved: true, icao24: null }), dep)).toEqual({
      state: 'resolved',
      action: 'none',
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
