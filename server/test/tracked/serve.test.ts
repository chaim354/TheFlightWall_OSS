import { describe, it, expect } from 'vitest';
import { trackedCards } from '../../src/tracked/serve';
import type { TrackedEntry } from '../../src/tracked/types';

const DAY = Date.UTC(2026, 8, 14);
const dep = DAY + 18 * 3600_000;
const arr = DAY + 25 * 3600_000;

const airborne = (over: Partial<TrackedEntry> = {}): TrackedEntry => ({
  id: 'e1', number: 'BA181', date: '2026-09-14', state: 'airborne', reason: null,
  attempts: 0, stateAtMs: DAY, reresolved: true, icao24: '4008f3', reg: 'G-STBA',
  origIata: 'JFK', destIata: 'LHR',
  orig: { lat: 40.6413, lon: -73.7781 }, dest: { lat: 51.47, lon: -0.4543 },
  schedDepEpoch: dep / 1000, schedArrEpoch: arr / 1000,
  lastLat: null, lastLon: null, lastPosAtMs: null, ...over,
});

describe('trackedCards', () => {
  it('emits a live card from a recent fix', () => {
    const now = dep + 3600_000;
    const cards = trackedCards([airborne({ lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now - 30_000 })], now);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.pin).toBe(true);
    expect(cards[0]!.pos_src).toBe('live');
    expect(cards[0]!.cs).toBe('BA181');
    expect(cards[0]!.from).toBe('JFK');
    expect(cards[0]!.to).toBe('LHR');
  });

  it('dead-reckons and labels ESTIMATED when the fix is stale', () => {
    // The whole point: an estimate must never be servable as a measurement.
    const now = dep + 3.5 * 3600_000;
    const cards = trackedCards([airborne({ lastLat: 45, lastLon: -50, lastPosAtMs: now - 20 * 60_000 })], now);
    expect(cards[0]!.pos_src).toBe('estimated');
    expect(cards[0]!.lat).toBeGreaterThan(51.47); // great circle bows north
  });

  it('dead-reckons when there has never been a fix', () => {
    const now = dep + 3.5 * 3600_000;
    const cards = trackedCards([airborne()], now);
    expect(cards[0]!.pos_src).toBe('estimated');
    expect(cards[0]!.lat).not.toBeNull();
  });

  it('emits nothing for states that are not airborne', () => {
    for (const state of ['pending', 'resolved', 'landed', 'unresolved', 'expired'] as const) {
      expect(trackedCards([airborne({ state })], dep + 3600_000)).toEqual([]);
    }
  });

  it('emits nothing when the route is unknown and there is no fix', () => {
    // Nothing measured, nothing derivable: no card beats a card at (0,0).
    expect(trackedCards([airborne({ orig: null, dest: null })], dep + 3600_000)).toEqual([]);
  });
});
