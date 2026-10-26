import { describe, it, expect, vi } from 'vitest';
import {
  runTrackedTick,
  reconcile,
  DAILY_RESOLVE_CEILING,
  MAX_AIRBORNE_POLLS,
  POLL_INTERVAL_MS,
} from '../../src/tracked/tick';
import type { TrackedEntry } from '../../src/tracked/types';
import type { TrackedStorage } from '../../src/tracked/store';

const DAY_START = Date.UTC(2026, 8, 14);

const entry = (over: Partial<TrackedEntry> = {}): TrackedEntry => ({
  id: 'e1', number: 'BA181', date: '2026-09-14', wantOrigIata: null, wantDestIata: null,
  state: 'pending', reason: null,
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
    expect(resolveFn).toHaveBeenCalledWith('BA181', '2026-09-14', {
      origIata: null,
      destIata: null,
    });
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
    const position = vi.fn().mockResolvedValue({
      ok: true,
      position: {
        lat: 41.5, lon: -80.1, onGround: false,
        altitudeFt: 31000, groundspeedKt: 440, headingDeg: 270, verticalRateFpm: 0,
      },
    });
    await runTrackedTick(store, dep + 5 * 60_000, {
      resolve: vi.fn(), position, resolvesUsedToday: 0, findHex,
    });
    const e = store.current[0]!;
    expect(e.icao24).toBe('a23138');
    expect(e.callsign).toBe('ENY3964');
    expect(e.reg).toBe('N240NN');
    expect(e.aircraftType).toBe('E75L');
    // And polled in the same pass, rather than a tick later: the hex is the
    // only thing that was standing between this flight and a card.
    expect(e.state).toBe('airborne');
    expect(position).toHaveBeenCalledWith('a23138');
    expect(e.lastLat).toBe(41.5);
    expect(e.lastPollAtMs).toBe(dep + 5 * 60_000);
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

describe('a flight added while it is already in the air', () => {
  // The latency this file was changed for: pending -> resolved -> airborne ->
  // polled used to take one 300s tick per arrow.
  const dep = DAY_START + 18 * 3600_000;
  const now = dep + 40 * 60_000;
  const inTheAir = {
    ...resolved,
    schedDepEpoch: dep / 1000,
    schedArrEpoch: (dep + 7 * 3600_000) / 1000,
  };
  const fix = {
    ok: true,
    position: {
      lat: 44.1, lon: -60.2, onGround: false,
      altitudeFt: 36000, groundspeedKt: 480, headingDeg: 60, verticalRateFpm: 0,
    },
  };

  it('resolves, goes airborne and takes its first fix in ONE pass', async () => {
    const store = memStore([entry()]);
    const resolveFn = vi.fn().mockResolvedValue({ ok: true, flight: inTheAir });
    const position = vi.fn().mockResolvedValue(fix);
    await runTrackedTick(store, now, { resolve: resolveFn, position, resolvesUsedToday: 0 });
    const e = store.current[0]!;
    expect(resolveFn).toHaveBeenCalledTimes(1);
    expect(e.state).toBe('airborne');
    expect(position).toHaveBeenCalledWith('4008f3');
    expect(e.lastLat).toBe(44.1);
    expect(e.lastPosAtMs).toBe(now);
  });

  it('never chains a resolve into a second resolve', async () => {
    // Resolved inside the hour before departure: the lifecycle would ask for
    // the re-resolve next. That stays a tick away -- chaining exists to save
    // latency, not to spend AeroDataBox calls faster.
    const soon = DAY_START + 18 * 3600_000 - 30 * 60_000;
    const store = memStore([entry()]);
    const resolveFn = vi.fn().mockResolvedValue({ ok: true, flight: resolved });
    await runTrackedTick(store, soon, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    expect(resolveFn).toHaveBeenCalledTimes(1);
    expect(store.current[0]!.state).toBe('resolved');
  });
});

describe('poll pacing on a fast tick', () => {
  const dep = DAY_START + 18 * 3600_000;
  const airborne = (over: Partial<TrackedEntry> = {}): TrackedEntry =>
    entry({
      ...resolved,
      state: 'airborne',
      reresolved: true,
      schedDepEpoch: dep / 1000,
      schedArrEpoch: (dep + 7 * 3600_000) / 1000,
      ...over,
    });
  const fix = {
    ok: true,
    position: {
      lat: 44.1, lon: -60.2, onGround: false,
      altitudeFt: 36000, groundspeedKt: 480, headingDeg: 60, verticalRateFpm: 0,
    },
  };

  it('polls an entry at most once per POLL_INTERVAL_MS however often the tick runs', async () => {
    const store = memStore([airborne()]);
    const position = vi.fn().mockResolvedValue(fix);
    const t0 = dep + 60 * 60_000;
    for (let i = 0; i < 5; i++) {
      await runTrackedTick(store, t0 + i * 60_000, { resolve: vi.fn(), position, resolvesUsedToday: 0 });
    }
    expect(position).toHaveBeenCalledTimes(1);
    await runTrackedTick(store, t0 + POLL_INTERVAL_MS, { resolve: vi.fn(), position, resolvesUsedToday: 0 });
    expect(position).toHaveBeenCalledTimes(2);
  });

  it('paces on the last ASK, not the last fix, so an ocean gap costs no more', async () => {
    const store = memStore([airborne()]);
    const position = vi.fn().mockResolvedValue({ ok: true, position: null });
    const t0 = dep + 60 * 60_000;
    for (let i = 0; i < 5; i++) {
      await runTrackedTick(store, t0 + i * 60_000, { resolve: vi.fn(), position, resolvesUsedToday: 0 });
    }
    expect(position).toHaveBeenCalledTimes(1);
    expect(store.current[0]!.lastPollAtMs).toBe(t0);
  });

  it('counts polls already made this window against MAX_AIRBORNE_POLLS', async () => {
    // Ten polled a minute ago and two more never polled: the two must wait,
    // or a 60s tick would allow five times the old OpenSky spend.
    const t0 = dep + 60 * 60_000;
    const recent = Array.from({ length: MAX_AIRBORNE_POLLS }, (_, i) =>
      airborne({ id: `r${i}`, icao24: `aa000${i}`, lastPollAtMs: t0 - 60_000 }),
    );
    const fresh = [airborne({ id: 'n1', icao24: 'bb0001' }), airborne({ id: 'n2', icao24: 'bb0002' })];
    const store = memStore([...recent, ...fresh]);
    const position = vi.fn().mockResolvedValue(fix);
    await runTrackedTick(store, t0, { resolve: vi.fn(), position, resolvesUsedToday: 0 });
    expect(position).not.toHaveBeenCalled();
  });
});

describe('reconcile', () => {
  // The store is read whole and written whole, and a tick holds its copy
  // across network calls. These are the writes that land in that gap.
  const a = entry({ id: 'a' });
  const b = entry({ id: 'b' });

  it('keeps an entry POSTed while the tick was running', () => {
    const added = entry({ id: 'new' });
    const out = reconcile([a, b, added], [a, b], [{ ...a, state: 'resolved' }, b]);
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'new']);
    expect(out[0]!.state).toBe('resolved');
  });

  it('does not resurrect an entry DELETEd while the tick was running', () => {
    const out = reconcile([a], [a, b], [a, { ...b, state: 'resolved' }]);
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('still drops what the tick itself dropped', () => {
    const out = reconcile([a, b], [a, b], [b]);
    expect(out.map((e) => e.id)).toEqual(['b']);
  });

  it('keeps an entry added during a real tick, end to end', async () => {
    const box = { current: [entry()] as TrackedEntry[] };
    const store = {
      async read() { return box.current; },
      async write(e: TrackedEntry[]) { box.current = e; },
    };
    const resolveFn = vi.fn().mockImplementation(async () => {
      // A POST lands while AeroDataBox is being asked.
      box.current = [...box.current, entry({ id: 'posted', number: 'DL1' })];
      return { ok: true, flight: resolved };
    });
    await runTrackedTick(store, DAY_START, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    expect(box.current.map((e) => e.id)).toEqual(['e1', 'posted']);
    expect(box.current[0]!.state).toBe('resolved');
  });
});
