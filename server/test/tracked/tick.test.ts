import { describe, it, expect, vi } from 'vitest';
import { runTrackedTick, DAILY_RESOLVE_CEILING } from '../../src/tracked/tick';
import type { TrackedEntry } from '../../src/tracked/types';
import type { TrackedStorage } from '../../src/tracked/store';

const DAY_START = Date.UTC(2026, 8, 14);

const entry = (over: Partial<TrackedEntry> = {}): TrackedEntry => ({
  id: 'e1', number: 'BA181', date: '2026-09-14', state: 'pending', reason: null,
  attempts: 0, stateAtMs: 0, reresolved: false, icao24: null, callsign: null, reg: null,
  aircraftModel: null, origIata: null, destIata: null, orig: null, dest: null,
  schedDepEpoch: null, schedArrEpoch: null,
  lastLat: null, lastLon: null, lastPosAtMs: null,
  lastAltFt: null, lastGroundspeedKt: null, lastHeadingDeg: null, lastVerticalRateFpm: null,
  ...over,
});

function memStore(initial: TrackedEntry[]): TrackedStorage & { current: TrackedEntry[] } {
  const box = {
    current: initial,
    async read() { return box.current; },
    async write(e: TrackedEntry[]) { box.current = e; },
  };
  return box;
}

const resolved = {
  icao24: '4008f3', reg: 'G-STBA', origIata: 'JFK', destIata: 'LHR',
  orig: { lat: 40.6413, lon: -73.7781 }, dest: { lat: 51.47, lon: -0.4543 },
  schedDepEpoch: Math.floor((DAY_START + 18 * 3600_000) / 1000),
  schedArrEpoch: Math.floor((DAY_START + 25 * 3600_000) / 1000),
};

describe('runTrackedTick', () => {
  it('resolves a pending entry once its date starts', async () => {
    const store = memStore([entry()]);
    const resolveFn = vi.fn().mockResolvedValue({ ok: true, flight: resolved });
    await runTrackedTick(store, DAY_START, {
      resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0,
    });
    expect(resolveFn).toHaveBeenCalledWith('BA181', '2026-09-14');
    expect(store.current[0]!.state).toBe('resolved');
    expect(store.current[0]!.icao24).toBe('4008f3');
  });

  it('marks a permanent miss unresolved and never calls again', async () => {
    const store = memStore([entry()]);
    const resolveFn = vi.fn().mockResolvedValue({ ok: false, retryable: false, reason: 'not operating 2026-09-14' });
    await runTrackedTick(store, DAY_START, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    expect(store.current[0]!.state).toBe('unresolved');
    expect(store.current[0]!.reason).toBe('not operating 2026-09-14');

    // Second tick: terminal, so no further call.
    resolveFn.mockClear();
    await runTrackedTick(store, DAY_START + 60_000, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    expect(resolveFn).not.toHaveBeenCalled();
  });

  it('retries a transport failure up to three times, then gives up', async () => {
    const store = memStore([entry()]);
    const resolveFn = vi.fn().mockResolvedValue({ ok: false, retryable: true, reason: 'HTTP 503' });
    for (let i = 0; i < 3; i++) {
      await runTrackedTick(store, DAY_START + i * 60_000, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    }
    expect(store.current[0]!.state).toBe('pending');
    expect(store.current[0]!.attempts).toBe(3);

    await runTrackedTick(store, DAY_START + 4 * 60_000, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    expect(store.current[0]!.state).toBe('unresolved');
  });

  it('refuses to resolve past the daily ceiling', async () => {
    // The ceiling is what stops an open endpoint draining the AeroDataBox quota.
    const store = memStore([entry()]);
    const resolveFn = vi.fn();
    await runTrackedTick(store, DAY_START, {
      resolve: resolveFn, position: vi.fn(), resolvesUsedToday: DAILY_RESOLVE_CEILING,
    });
    expect(resolveFn).not.toHaveBeenCalled();
    expect(store.current[0]!.state).toBe('pending');
  });

  it('polls OpenSky once airborne and stores the live fix', async () => {
    const store = memStore([entry({ state: 'resolved', reresolved: true, ...resolved })]);
    const positionFn = vi.fn().mockResolvedValue({
      ok: true, position: { lat: 52.1, lon: -30.5, altitudeFt: 37000, headingDeg: 62, onGround: false, seenAtEpoch: 1 },
    });
    await runTrackedTick(store, DAY_START + 18 * 3600_000, {
      resolve: vi.fn(), position: positionFn, resolvesUsedToday: 0,
    });
    expect(positionFn).toHaveBeenCalledWith('4008f3');
    expect(store.current[0]!.state).toBe('airborne');
    expect(store.current[0]!.lastLat).toBeCloseTo(52.1, 3);
  });

  it('lands the flight when OpenSky reports on-ground', async () => {
    const store = memStore([entry({ state: 'airborne', reresolved: true, ...resolved })]);
    const positionFn = vi.fn().mockResolvedValue({
      ok: true, position: { lat: 51.4, lon: -0.45, altitudeFt: 0, headingDeg: 0, onGround: true, seenAtEpoch: 1 },
    });
    await runTrackedTick(store, DAY_START + 20 * 3600_000, {
      resolve: vi.fn(), position: positionFn, resolvesUsedToday: 0,
    });
    expect(store.current[0]!.state).toBe('landed');
  });

  it('keeps the entry airborne when OpenSky sees nothing', async () => {
    // The ocean gap. Dropping to landed here would end tracking mid-Atlantic.
    const store = memStore([entry({ state: 'airborne', reresolved: true, ...resolved })]);
    await runTrackedTick(store, DAY_START + 20 * 3600_000, {
      resolve: vi.fn(), position: vi.fn().mockResolvedValue({ ok: true, position: null }), resolvesUsedToday: 0,
    });
    expect(store.current[0]!.state).toBe('airborne');
  });

  it('persists the REASON when the lifecycle declares an entry unresolved', async () => {
    // decideTracked can decide an entry is unresolved on its own -- e.g. it
    // resolved without a departure time and so can never become airborne.
    // Without carrying the reason across, GET /v1/tracked shows state
    // 'unresolved' with reason null, which tells the user their flight is not
    // being tracked but not the one thing they need in order to fix it.
    const store = memStore([entry({ state: 'resolved', icao24: '406947', schedDepEpoch: null })]);
    await runTrackedTick(store, DAY_START, { resolve: vi.fn(), position: vi.fn(), resolvesUsedToday: 0 });
    expect(store.current[0]!.state).toBe('unresolved');
    expect(store.current[0]!.reason).toBe('resolved without a departure time');
  });

  it('drops expired entries from the store', async () => {
    const store = memStore([entry({ state: 'landed', stateAtMs: DAY_START })]);
    await runTrackedTick(store, DAY_START + 3 * 3600_000, {
      resolve: vi.fn(), position: vi.fn(), resolvesUsedToday: 0,
    });
    expect(store.current).toEqual([]);
  });

  // Beyond the plan's own tests: the ceiling is only a meaningful budget bound
  // if it is re-checked for every entry in the pass, not read once against the
  // batch. An unauthenticated caller can queue as many entries as the store
  // allows in one request burst, so a single tick may face several of them
  // wanting to resolve at once with the day's budget already mostly spent.

  it('checks the ceiling per entry within one tick, not once for the whole batch', async () => {
    // Only one slot of budget remains. If the ceiling were sampled once up
    // front instead of tracked as a running count through the loop, all three
    // queued entries would read that single "still under budget" snapshot and
    // every one of them would call out.
    const store = memStore([
      entry({ id: 'e1', number: 'BA181' }),
      entry({ id: 'e2', number: 'BA182' }),
      entry({ id: 'e3', number: 'BA183' }),
    ]);
    const resolveFn = vi.fn().mockResolvedValue({ ok: true, flight: resolved });
    await runTrackedTick(store, DAY_START, {
      resolve: resolveFn, position: vi.fn(), resolvesUsedToday: DAILY_RESOLVE_CEILING - 1,
    });
    expect(resolveFn).toHaveBeenCalledTimes(1);
    expect(store.current[0]!.state).toBe('resolved');
    expect(store.current[1]!.state).toBe('pending');
    expect(store.current[2]!.state).toBe('pending');
  });

  it('lets exactly the ceiling worth of entries through in one tick, no more', async () => {
    // The literal "entry 51" case: a pathologically large store, one tick,
    // budget starting fresh at zero. Entries beyond DAILY_RESOLVE_CEILING must
    // wait for tomorrow's budget rather than slip through the same pass.
    const entries = Array.from({ length: DAILY_RESOLVE_CEILING + 1 }, (_, i) =>
      entry({ id: `e${i}`, number: `BA${100 + i}` }),
    );
    const store = memStore(entries);
    const resolveFn = vi.fn().mockResolvedValue({ ok: true, flight: resolved });
    await runTrackedTick(store, DAY_START, {
      resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0,
    });
    expect(resolveFn).toHaveBeenCalledTimes(DAILY_RESOLVE_CEILING);
    expect(store.current.filter((e) => e.state === 'resolved')).toHaveLength(DAILY_RESOLVE_CEILING);
    // Index DAILY_RESOLVE_CEILING is the (CEILING + 1)th entry -- "entry 51"
    // when the ceiling is 50 -- and must still be waiting.
    expect(store.current[DAILY_RESOLVE_CEILING]!.state).toBe('pending');
  });
});
