import { describe, it, expect } from 'vitest';
import { indexRows, lookupRows, lookupByCallsign, STALE_AFTER_MS, kvStorage, saveSchedule, loadSchedule, isStale, KV_KEY } from '../src/schedule/store';
import type { ScheduleRow } from '../src/types';

// Minimal in-memory stand-in for the Workers KVNamespace binding, matching
// the one in test/flights.test.ts -- only get/put, only the 'json' get
// overload, no Miniflare and no real network.
class FakeKV {
  private store = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

// NOTE: this file covers only the KV-indexing half of Task 7
// (indexRows/lookupRows/lookupByCallsign/STALE_AFTER_MS). The FIDS-parsing
// half (parseFids, fetchBoard, getAirportCoord in
// src/schedule/aerodatabox.ts and src/schedule/airports.ts) lives in its own
// file, test/fids.test.ts, rather than joining this one -- it was blocked on
// an AeroDataBox key and a live fixture at the time this file was split off;
// both exist now, see test/fids.test.ts and fixtures/README.md. The plan's
// original sketch put both halves in one test/schedule.test.ts with a single
// module-scope fixture import; keeping them in two files instead avoids that
// file importing a fixture the store tests never use.

describe('indexRows / lookupRows', () => {
  const rows: ScheduleRow[] = [
    { callsign: null, carrierIata: 'DL', number: '5075', origIata: 'CVG', destIata: 'LGA',
      origLat: 39.0, origLon: -84.7, destLat: 40.78, destLon: -73.87, schedArrEpoch: null, revArrEpoch: null },
    { callsign: null, carrierIata: 'AA', number: '5075', origIata: 'DFW', destIata: 'JFK',
      origLat: 32.9, origLon: -97.0, destLat: 40.64, destLon: -73.78, schedArrEpoch: null, revArrEpoch: null },
    { callsign: null, carrierIata: 'UA', number: '1630', origIata: 'ORD', destIata: 'EWR',
      origLat: 41.98, origLon: -87.9, destLat: 40.69, destLon: -74.17, schedArrEpoch: null, revArrEpoch: null },
  ];

  it('groups rows by flight number', () => {
    const idx = indexRows(rows);
    expect(lookupRows(idx, '5075')).toHaveLength(2);
    expect(lookupRows(idx, '1630')).toHaveLength(1);
    expect(lookupRows(idx, '9999')).toHaveLength(0);
  });

  it('round-trips through JSON, since KV stores strings', () => {
    const idx = indexRows(rows);
    const revived = JSON.parse(JSON.stringify(idx));
    expect(lookupRows(revived, '5075')).toHaveLength(2);
  });

  it('leaves byCallsign empty when no row carries one, without throwing', () => {
    // This is the state Task 1 may well have found. It must degrade to the
    // number path, not blow up.
    const idx = indexRows(rows);
    expect(Object.keys(idx.byCallsign)).toHaveLength(0);
    expect(lookupByCallsign(idx, 'EDV5075')).toEqual([]);
  });

  it('declares a staleness window longer than the refresh interval', () => {
    // Cron runs every 6h; the table must not read as stale between runs.
    expect(STALE_AFTER_MS).toBeGreaterThan(6 * 60 * 60 * 1000);
  });
});

describe('kvStorage (Task 1: the Worker-side ScheduleStorage adapter)', () => {
  const rows: ScheduleRow[] = [
    { callsign: null, carrierIata: 'DL', number: '5075', origIata: 'CVG', destIata: 'LGA',
      origLat: 39.0, origLon: -84.7, destLat: 40.78, destLon: -73.87, schedArrEpoch: null, revArrEpoch: null },
  ];

  it('round-trips a saveSchedule/loadSchedule pair through the same JSON shape KV stored before Task 1', async () => {
    const kv = new FakeKV();
    const storage = kvStorage(kv as unknown as KVNamespace);
    await saveSchedule(storage, rows, 1_700_000_000_000);
    const loaded = await loadSchedule(storage);
    expect(loaded?.builtAtMs).toBe(1_700_000_000_000);
    expect(lookupRows(loaded!.index, '5075')).toHaveLength(1);
    // Same key as always -- a reader written against raw KV (or an
    // in-flight KV dashboard inspection) still finds the table.
    expect(await kv.get(KV_KEY, 'json')).not.toBeNull();
  });

  it('returns null, matching a real KV miss, when nothing has been written yet', async () => {
    const storage = kvStorage(new FakeKV() as unknown as KVNamespace);
    expect(await loadSchedule(storage)).toBeNull();
  });
});

describe('loadSchedule: a parsed value is not a valid table', () => {
  // F-SRV09R-A. Both backends deserialize with an unchecked cast --
  // fileStorage's `JSON.parse(raw) as StoredSchedule` and kvStorage's
  // `kv.get<StoredSchedule>(...)` -- so read() promises StoredSchedule|null
  // while the non-null branch may be ANY JSON value. fileStorage's own comment
  // promises corrupt files degrade to null, and that holds for syntactically
  // bad JSON only.
  //
  // The damage is specific: for {"index":{}}, isStale computes
  // nowMs - undefined = NaN, and NaN > STALE_AFTER_MS is FALSE -- so the table
  // reports itself FRESH, forever. handleFlights then dereferences
  // stored.index.byCallsign and throws a TypeError thirty lines past the
  // .catch() that was supposed to cover the read. Node turns that into a 500 on
  // EVERY request; the Worker path has no catch at all.
  //
  // The codebase already knows the type lies: refresh.ts hand-rolls exactly
  // this guard before touching index.byNumber. One consumer had it, one did
  // not, which is why the two paths behaved differently on the same bad file.

  const badShapes: [string, unknown][] = [
    ['no builtAtMs', { index: { byNumber: {}, byCallsign: {} } }],
    ['no index', { builtAtMs: 1 }],
    ['index is not an object', { builtAtMs: 1, index: 'nope' }],
    ['byCallsign missing', { builtAtMs: 1, index: { byNumber: {} } }],
    ['byNumber missing', { builtAtMs: 1, index: { byCallsign: {} } }],
    ['builtAtMs is not a number', { builtAtMs: 'soon', index: { byNumber: {}, byCallsign: {} } }],
    ['a bare array', []],
    ['a bare string', 'schedule'],
    ['a number', 42],
  ];

  for (const [name, value] of badShapes) {
    it(`rejects ${name} rather than passing it off as a table`, async () => {
      const kv = new FakeKV();
      await kv.put(KV_KEY, JSON.stringify(value));
      expect(await loadSchedule(kvStorage(kv as unknown as KVNamespace))).toBeNull();
    });
  }

  it('a rejected table reads as stale, not as fresh-forever', async () => {
    // The specific NaN trap: without the guard this returns false.
    const kv = new FakeKV();
    await kv.put(KV_KEY, JSON.stringify({ index: {} }));
    const loaded = await loadSchedule(kvStorage(kv as unknown as KVNamespace));
    expect(isStale(loaded, Date.now())).toBe(true);
  });

  it('still accepts a real table', async () => {
    const kv = new FakeKV();
    const rows: ScheduleRow[] = [{
      callsign: 'DAL1', carrierIata: 'DL', number: '1', origIata: 'JFK', destIata: 'LAX',
      origLat: 40.6, origLon: -73.8, destLat: 33.9, destLon: -118.4,
      schedArrEpoch: null, revArrEpoch: null,
    }];
    const storage = kvStorage(kv as unknown as KVNamespace);
    await saveSchedule(storage, rows, 5000);
    const loaded = await loadSchedule(storage);
    expect(loaded?.builtAtMs).toBe(5000);
    expect(loaded?.index.byNumber['1']).toHaveLength(1);
  });
});
