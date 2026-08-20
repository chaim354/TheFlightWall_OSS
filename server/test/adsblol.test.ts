import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAdsbLol } from '../src/adsblol';

const raw = JSON.parse(readFileSync(new URL('../fixtures/adsblol-jfk.json', import.meta.url), 'utf8'));

describe('parseAdsbLol', () => {
  const aircraft = parseAdsbLol(raw);

  it('parses every aircraft that has a position', () => {
    expect(aircraft.length).toBeGreaterThan(50);
    for (const a of aircraft) {
      expect(Number.isFinite(a.lat)).toBe(true);
      expect(Number.isFinite(a.lon)).toBe(true);
    }
  });

  it('trims the callsign', () => {
    for (const a of aircraft) expect(a.callsign).toBe(a.callsign.trim());
  });

  it('carries registration and type inline, so no per-flight lookup is needed', () => {
    const withType = aircraft.filter((a) => a.typeIcao);
    const withReg = aircraft.filter((a) => a.registration);
    expect(withType.length / aircraft.length).toBeGreaterThan(0.8);
    expect(withReg.length / aircraft.length).toBeGreaterThan(0.8);
  });

  it('carries precomputed distance and bearing', () => {
    const withDst = aircraft.filter((a) => a.distanceNm !== null);
    expect(withDst.length / aircraft.length).toBeGreaterThan(0.9);
  });

  it('treats a ground-string altitude as on-ground rather than NaN', () => {
    // adsb.lol reports alt_baro as the string "ground" for surface aircraft.
    const parsed = parseAdsbLol({ ac: [{ hex: 'abc123', flight: 'TEST1 ', lat: 40, lon: -73, alt_baro: 'ground' }] });
    expect(parsed[0]!.onGround).toBe(true);
    expect(parsed[0]!.altFt).toBeNull();
  });

  it('drops rows with no position', () => {
    const parsed = parseAdsbLol({ ac: [{ hex: 'abc123', flight: 'TEST1' }] });
    expect(parsed).toHaveLength(0);
  });

  it('survives a malformed payload without throwing', () => {
    expect(parseAdsbLol({})).toEqual([]);
    expect(parseAdsbLol({ ac: null })).toEqual([]);
  });
});
