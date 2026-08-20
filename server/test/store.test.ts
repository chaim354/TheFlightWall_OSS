import { describe, it, expect } from 'vitest';
import { indexRows, lookupRows, lookupByCallsign, STALE_AFTER_MS } from '../src/schedule/store';
import type { ScheduleRow } from '../src/types';

// NOTE: this file covers only the KV-indexing half of Task 7
// (indexRows/lookupRows/lookupByCallsign/STALE_AFTER_MS). The FIDS-parsing
// half (parseFids, fetchBoard, BOARD_AIRPORTS/FAR_AIRPORT_COORDS in
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
      origLat: 39.0, origLon: -84.7, destLat: 40.78, destLon: -73.87, schedArrEpoch: null },
    { callsign: null, carrierIata: 'AA', number: '5075', origIata: 'DFW', destIata: 'JFK',
      origLat: 32.9, origLon: -97.0, destLat: 40.64, destLon: -73.78, schedArrEpoch: null },
    { callsign: null, carrierIata: 'UA', number: '1630', origIata: 'ORD', destIata: 'EWR',
      origLat: 41.98, origLon: -87.9, destLat: 40.69, destLon: -74.17, schedArrEpoch: null },
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
