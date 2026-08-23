import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/schedule/aerodatabox', () => ({ fetchBoard: vi.fn() }));

import { fetchBoard } from '../src/schedule/aerodatabox';
import { refreshSchedule } from '../src/schedule/refresh';
import { matchSchedule } from '../src/join';
import type { ScheduleStorage, StoredSchedule } from '../src/schedule/store';
import type { ScheduleRow } from '../src/types';

class FakeStorage implements ScheduleStorage {
  value: StoredSchedule | null = null;
  async read(): Promise<StoredSchedule | null> {
    return this.value;
  }
  async write(s: StoredSchedule): Promise<void> {
    this.value = s;
  }
}

const row = (number: string): ScheduleRow => ({
  callsign: null, carrierIata: 'DL', number, origIata: 'CVG', destIata: 'LGA',
  origLat: 39.0, origLon: -84.7, destLat: 40.78, destLon: -73.87, schedArrEpoch: null, revArrEpoch: null,
});

beforeEach(() => {
  vi.mocked(fetchBoard).mockReset();
});

describe('refreshSchedule: happy path', () => {
  it('saves the combined rows from every board', async () => {
    vi.mocked(fetchBoard).mockResolvedValueOnce([row('1')]).mockResolvedValueOnce([row('2')]);
    const storage = new FakeStorage();
    await refreshSchedule(['KJFK', 'KLGA'], 'key', storage, 1000, 0);
    expect(storage.value?.builtAtMs).toBe(1000);
    expect(Object.keys(storage.value!.index.byNumber).sort()).toEqual(['1', '2']);
  });
});

describe('refreshSchedule: partial and total failure', () => {
  it('saves whatever succeeded when only some boards fail', async () => {
    vi.mocked(fetchBoard).mockResolvedValueOnce([row('1')]).mockRejectedValueOnce(new Error('429'));
    const storage = new FakeStorage();
    await refreshSchedule(['KJFK', 'KLGA'], 'key', storage, 3000, 0);
    expect(storage.value?.builtAtMs).toBe(3000);
    expect(Object.keys(storage.value!.index.byNumber)).toEqual(['1']);
  });

  it('keeps the previous table rather than overwriting with empty when every board fails', async () => {
    // The guard this was ported from index.ts's original scheduled() --
    // a fully empty result would blank every route until the next refresh.
    vi.mocked(fetchBoard).mockRejectedValue(new Error('429'));
    const storage = new FakeStorage();
    storage.value = { builtAtMs: 1, index: { byNumber: { '9': [row('9')] }, byCallsign: {} } };
    await refreshSchedule(['KJFK', 'KLGA'], 'key', storage, 2000, 0);
    expect(storage.value?.builtAtMs).toBe(1); // untouched
    expect(storage.value?.index.byNumber['9']).toBeDefined();
  });

  it('does not throw when every board fails and nothing was ever stored', async () => {
    vi.mocked(fetchBoard).mockRejectedValue(new Error('network down'));
    const storage = new FakeStorage();
    await expect(refreshSchedule(['KJFK'], 'key', storage, 1000, 0)).resolves.toBeUndefined();
    expect(storage.value).toBeNull();
  });
});

describe('refreshSchedule: pacing', () => {
  it('waits delayMs between boards, but not before the first or after the last', async () => {
    vi.mocked(fetchBoard).mockResolvedValue([]);
    const storage = new FakeStorage();
    const start = Date.now();
    await refreshSchedule(['KJFK', 'KLGA', 'KEWR'], 'key', storage, 6000, 30);
    const elapsed = Date.now() - start;
    // 3 boards -> 2 gaps, not 3: a trailing delay after the last board would
    // add pure latency for no rate-limiting benefit.
    expect(elapsed).toBeGreaterThanOrEqual(55); // 2 * 30ms, with slack for scheduling jitter
    expect(elapsed).toBeLessThan(400); // well under what a 3rd gap (or worse) would produce
  });

  it('does not delay at all when delayMs is 0', async () => {
    vi.mocked(fetchBoard).mockResolvedValue([]);
    const storage = new FakeStorage();
    const start = Date.now();
    await refreshSchedule(['KJFK', 'KLGA', 'KEWR', 'KBOS'], 'key', storage, 5000, 0);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('refreshSchedule: never writes a table it could not populate', () => {
  // F-SRV10-B. `ok` counted fetches that did not throw, so `ok > 0` with zero
  // rows wrote an EMPTY table carrying a fresh builtAtMs -- and isStale() reads
  // builtAtMs alone, so it reported stale:false with no routes and rewrote
  // itself identically every cron tick. Self-sustaining and invisible.
  // parseFids returns [] on a payload-shape change, which is the live trigger.

  it('does not write when every board answered 200 but produced no rows', async () => {
    vi.mocked(fetchBoard).mockResolvedValue([]);
    const storage = new FakeStorage();
    storage.value = { builtAtMs: 1, index: { byNumber: { '9': [row('9')] }, byCallsign: {} } };

    await refreshSchedule(['KJFK', 'KLGA', 'KEWR', 'KBOS'], 'key', storage, 9_000_000, 0);

    // Both halves matter: the rows must survive AND builtAtMs must not be
    // restamped, or the stale table starts reporting itself as fresh.
    expect(storage.value?.builtAtMs).toBe(1);
    expect(storage.value?.index.byNumber['9']).toBeDefined();
  });

  it('leaves nothing stored rather than storing an empty-but-fresh table', async () => {
    vi.mocked(fetchBoard).mockResolvedValue([]);
    const storage = new FakeStorage();

    await refreshSchedule(['KJFK', 'KLGA'], 'key', storage, 9_000_000, 0);

    expect(storage.value).toBeNull();
  });
});

describe('refreshSchedule: one row per flight leg', () => {
  // F-SRV10-A. Every board is fetched `direction=Both`, so a JFK->BOS leg is
  // built from the KJFK board (as a departure) AND the KBOS board (as an
  // arrival) -- field-for-field identical, because airports.ts is one unified
  // table and the arrival sub-object is the scheduled arrival either way.
  // Two identical rows then score an identical corridor excess, and
  // matchSchedule's tiebreak refuses to pick either: a deterministic blank
  // route for exactly the inter-board shuttle traffic overhead.

  const leg = row('100');

  it('collapses the identical row two boards produce for the same leg', async () => {
    vi.mocked(fetchBoard).mockResolvedValueOnce([leg]).mockResolvedValueOnce([leg]);
    const storage = new FakeStorage();

    await refreshSchedule(['KJFK', 'KBOS'], 'key', storage, 1000, 0);

    expect(storage.value!.index.byNumber['100']).toHaveLength(1);
  });

  it('and that single row still matches, where the duplicate pair blanked it', async () => {
    // Assert on the actual join, not just the row count -- the failure is
    // silent and downstream.
    vi.mocked(fetchBoard).mockResolvedValueOnce([leg]).mockResolvedValueOnce([leg]);
    const storage = new FakeStorage();
    await refreshSchedule(['KJFK', 'KBOS'], 'key', storage, 1000, 0);

    const stored = Object.values(storage.value!.index.byNumber).flat();
    const hit = matchSchedule('DAL100', 40.5, -75.5, stored, 1000);
    expect(hit).not.toBeNull();
    expect(hit!.destIata).toBe('LGA');

    // The counterfactual: the un-collapsed pair really does blank.
    expect(matchSchedule('DAL100', 40.5, -75.5, [leg, { ...leg }], 1000)).toBeNull();
  });

  it('still keeps genuinely different legs apart', async () => {
    vi.mocked(fetchBoard)
      .mockResolvedValueOnce([row('100')])
      .mockResolvedValueOnce([row('200')]);
    const storage = new FakeStorage();

    await refreshSchedule(['KJFK', 'KBOS'], 'key', storage, 1000, 0);

    expect(Object.keys(storage.value!.index.byNumber).sort()).toEqual(['100', '200']);
  });
});

describe('refreshSchedule: partial board coverage', () => {
  // F-SRV10-C. The gap neither of the guards above closes: if ONE board's
  // payload shape changes, parseFids returns [] for it while the others still
  // contribute, so `rows.length > 0` and the write proceeds. A table missing a
  // quarter of its coverage is stored with a fresh builtAtMs and reads as
  // perfectly healthy. Every plausible cause is a defect -- a shape change, an
  // unknown board ICAO that collect() bails on, a board silently rate-limited
  // into an empty body -- because a 12h FIDS window at KJFK/KLGA/KEWR/KBOS is
  // never legitimately empty. So it has to be visible on the operator's
  // channel, by name.

  const capture = () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    return { lines, restore: () => spy.mockRestore() };
  };

  it('names the board that answered but produced nothing', async () => {
    const { lines, restore } = capture();
    vi.mocked(fetchBoard).mockResolvedValueOnce([row('1')]).mockResolvedValueOnce([]);
    const storage = new FakeStorage();

    await refreshSchedule(['KJFK', 'KBOS'], 'key', storage, 1000, 0);
    restore();

    expect(lines.join('\n')).toMatch(/KBOS/);
  });

  it('still writes the coverage it did get, rather than discarding it', async () => {
    const { restore } = capture();
    vi.mocked(fetchBoard).mockResolvedValueOnce([row('1')]).mockResolvedValueOnce([]);
    const storage = new FakeStorage();

    await refreshSchedule(['KJFK', 'KBOS'], 'key', storage, 1000, 0);
    restore();

    expect(storage.value?.index.byNumber['1']).toBeDefined();
    expect(storage.value?.builtAtMs).toBe(1000);
  });

  it('says nothing when every board produced rows', async () => {
    const { lines, restore } = capture();
    vi.mocked(fetchBoard).mockResolvedValueOnce([row('1')]).mockResolvedValueOnce([row('2')]);
    const storage = new FakeStorage();

    await refreshSchedule(['KJFK', 'KBOS'], 'key', storage, 1000, 0);
    restore();

    expect(lines).toEqual([]);
  });
});
