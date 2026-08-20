import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/schedule/aerodatabox', () => ({ fetchBoard: vi.fn() }));

import { fetchBoard } from '../src/schedule/aerodatabox';
import { refreshSchedule } from '../src/schedule/refresh';
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
  origLat: 39.0, origLon: -84.7, destLat: 40.78, destLon: -73.87, schedArrEpoch: null,
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
