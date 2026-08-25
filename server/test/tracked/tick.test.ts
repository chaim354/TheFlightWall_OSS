import { describe, it, expect, vi } from 'vitest';
import { runTrackedTick, DAILY_RESOLVE_CEILING, MAX_AIRBORNE_POLLS } from '../../src/tracked/tick';
import type { TrackedEntry } from '../../src/tracked/types';
import type { TrackedStorage } from '../../src/tracked/store';

const DAY_START = Date.UTC(2026, 8, 14);

const entry = (over: Partial<TrackedEntry> = {}): TrackedEntry => ({
  id: 'e1', number: 'BA181', date: '2026-09-14', state: 'pending', reason: null,
  attempts: 0, stateAtMs: 0, reresolved: false, source: 'manual', icao24: null, callsign: null, reg: null,
  aircraftModel: null, aircraftType: null, origIata: null, destIata: null, orig: null, dest: null,
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

  it('logs when it drops an entry, naming the state it was dropped from', () => {
    // Regression on DIAGNOSABILITY, not on behaviour. The drop path was silent,
    // so an entry swept by a bad bound left an empty store and nothing else --
    // no state, no reason, no log line. "expired from landed" is the feature
    // working; "expired from pending" is a bug, and only the log tells them
    // apart after the entry is gone.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    return runTrackedTick(
      memStore([entry({ number: 'DL1732', date: '2026-08-24', state: 'landed', stateAtMs: 0 })]),
      DAY_START + 400 * 24 * 60 * 60_000, // far past every expiry timer
      { resolve: vi.fn(), position: vi.fn(), resolvesUsedToday: 0 },
    ).then(() => {
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('dropped'));
      expect(line).toContain('DL1732');
      expect(line).toContain('2026-08-24');
      expect(line).toContain('expired from landed');
      log.mockRestore();
    });
  });
});

describe('the OpenSky budget is a CONCURRENCY limit, not a store-size one', () => {
  // Entries are cheap; only `airborne` ones cost credits. A calendar's worth of
  // flights spread over a fortnight can far exceed the store cap that used to
  // stand in for this, while only a handful are ever in the air at once. The
  // guard belongs where the cost is.
  const airborne = (i: number): TrackedEntry =>
    entry({
      ...resolved,
      id: `a${i}`, number: `XX${100 + i}`, state: 'airborne', icao24: `hex${i}`,
      reresolved: true,
    });

  const fix = { ok: true as const, position: { lat: 51, lon: -1, altFt: 30000, groundspeedKt: 450, headingDeg: 90, verticalRateFpm: 0, onGround: false } };

  it('polls every airborne entry while under the cap', async () => {
    const store = memStore(Array.from({ length: 6 }, (_, i) => airborne(i)));
    const positionFn = vi.fn().mockResolvedValue(fix);
    await runTrackedTick(store, DAY_START + 20 * 3600_000, {
      resolve: vi.fn(), position: positionFn, resolvesUsedToday: 0,
    });
    expect(positionFn).toHaveBeenCalledTimes(6);
  });

  it('stops at MAX_AIRBORNE_POLLS rather than blowing the daily credit budget', async () => {
    // A single-icao24 query costs FOUR credits against 4000/day, so the real
    // budget is ~1000 queries. At the 300s tick an eight-hour flight costs 96,
    // which is what makes ten the honest concurrent ceiling.
    const store = memStore(Array.from({ length: MAX_AIRBORNE_POLLS + 5 }, (_, i) => airborne(i)));
    const positionFn = vi.fn().mockResolvedValue(fix);
    await runTrackedTick(store, DAY_START + 20 * 3600_000, {
      resolve: vi.fn(), position: positionFn, resolvesUsedToday: 0,
    });
    expect(positionFn).toHaveBeenCalledTimes(MAX_AIRBORNE_POLLS);
  });

  it('leaves an unpolled entry airborne with its last fix, to dead-reckon from', async () => {
    // Not an error and not a drop: the card keeps rendering off the last known
    // position, which is the same path an ocean gap already takes.
    const store = memStore(Array.from({ length: MAX_AIRBORNE_POLLS + 1 }, (_, i) => airborne(i)));
    await runTrackedTick(store, DAY_START + 20 * 3600_000, {
      resolve: vi.fn(), position: vi.fn().mockResolvedValue(fix), resolvesUsedToday: 0,
    });
    const last = store.current[store.current.length - 1]!;
    expect(last.state).toBe('airborne');
  });
});

describe('performing the ADS-B hex sweep', () => {
  const dep = DAY_START + 18 * 3600_000;
  const hexless = entry({
    state: 'resolved', icao24: null, reresolved: true,
    schedDepEpoch: dep / 1000, schedArrEpoch: (dep + 3 * 3600_000) / 1000,
    orig: { lat: 41.067, lon: -73.7076 }, dest: { lat: 41.9786, lon: -87.9048 },
  });

  it('adopts the hex it finds and goes airborne on the same tick', async () => {
    const store = memStore([hexless]);
    const findHex = vi.fn().mockResolvedValue({
      hex: 'a23138', callsign: 'ENY3964', registration: 'N240NN', typeIcao: 'E75L',
    });
    await runTrackedTick(store, dep + 5 * 60_000, {
      resolve: vi.fn(), position: vi.fn(), resolvesUsedToday: 0, findHex,
    });
    const e = store.current[0]!;
    expect(e.icao24).toBe('a23138');
    expect(e.callsign).toBe('ENY3964');
    expect(e.reg).toBe('N240NN');
    expect(e.aircraftType).toBe('E75L');
  });

  it('leaves the entry alone when nothing is broadcasting that number', async () => {
    // Not a failure: the flight may be out of receiver coverage, or late. It
    // stays resolved and the next tick sweeps again until arrival passes.
    const store = memStore([hexless]);
    await runTrackedTick(store, dep + 5 * 60_000, {
      resolve: vi.fn(), position: vi.fn(), resolvesUsedToday: 0,
      findHex: vi.fn().mockResolvedValue(null),
    });
    const e = store.current[0]!;
    expect(e.state).toBe('resolved');
    expect(e.icao24).toBeNull();
  });

  it('survives a sweep that throws, without killing the tick', async () => {
    // The second entry is deliberately inert (landed, well inside its 2h
    // expiry) so this test measures ONE thing: that a throwing sweep does not
    // stop the tick reaching the entries after it.
    const store = memStore([
      hexless,
      entry({ id: 'other', number: 'BA181', state: 'landed', stateAtMs: dep + 5 * 60_000 }),
    ]);
    await runTrackedTick(store, dep + 5 * 60_000, {
      resolve: vi.fn(), position: vi.fn(), resolvesUsedToday: 0,
      findHex: vi.fn().mockRejectedValue(new Error('adsb.lol down')),
    });
    expect(store.current).toHaveLength(2);
  });
});
