import { describe, it, expect } from 'vitest';
import { haversineKm, bearingDeg, corridorExcessKm, KM_PER_NM } from '../src/geo';

const JFK = { lat: 40.6413, lon: -73.7781 };
const LAX = { lat: 33.9416, lon: -118.4085 };
const BOS = { lat: 42.3656, lon: -71.0096 };

describe('haversineKm', () => {
  it('measures a known long leg', () => {
    // JFK-LAX great circle is ~3974 km.
    expect(haversineKm(JFK.lat, JFK.lon, LAX.lat, LAX.lon)).toBeCloseTo(3974, -1);
  });

  it('is zero for identical points and symmetric', () => {
    expect(haversineKm(JFK.lat, JFK.lon, JFK.lat, JFK.lon)).toBe(0);
    expect(haversineKm(JFK.lat, JFK.lon, BOS.lat, BOS.lon))
      .toBeCloseTo(haversineKm(BOS.lat, BOS.lon, JFK.lat, JFK.lon), 9);
  });

  it('handles antimeridian crossing without going the long way', () => {
    // 179E to 179W is 2 degrees apart, not 358.
    expect(haversineKm(0, 179, 0, -179)).toBeLessThan(250);
  });
});

describe('bearingDeg', () => {
  it('points north, east, south, west', () => {
    expect(bearingDeg(0, 0, 10, 0)).toBeCloseTo(0, 1);
    expect(bearingDeg(0, 0, 0, 10)).toBeCloseTo(90, 1);
    expect(bearingDeg(0, 0, -10, 0)).toBeCloseTo(180, 1);
    expect(bearingDeg(0, 0, 0, -10)).toBeCloseTo(270, 1);
  });

  it('always returns 0..360', () => {
    const b = bearingDeg(JFK.lat, JFK.lon, LAX.lat, LAX.lon);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});

describe('corridorExcessKm', () => {
  it('is ~0 for a point on the route', () => {
    expect(corridorExcessKm(JFK.lat, JFK.lon, JFK.lat, JFK.lon, LAX.lat, LAX.lon))
      .toBeCloseTo(0, 6);
  });

  it('is large for a point nowhere near the route', () => {
    // Aircraft over New York, claimed route SFO-LAX. This is the real SWA1304
    // case: the enrichment database returned SFO-LAX for an aircraft over NYC.
    const SFO = { lat: 37.6188, lon: -122.375 };
    const excess = corridorExcessKm(JFK.lat, JFK.lon, SFO.lat, SFO.lon, LAX.lat, LAX.lon);
    expect(excess).toBeGreaterThan(5000);
  });

  it('is small for a point mid-route', () => {
    // Midpoint of JFK-LAX, roughly over Kansas.
    const excess = corridorExcessKm(39.0, -96.0, JFK.lat, JFK.lon, LAX.lat, LAX.lon);
    expect(excess).toBeLessThan(200);
  });

  it('never returns negative', () => {
    expect(corridorExcessKm(JFK.lat, JFK.lon, BOS.lat, BOS.lon, LAX.lat, LAX.lon))
      .toBeGreaterThanOrEqual(0);
  });
});

describe('KM_PER_NM', () => {
  it('is the international nautical mile', () => {
    expect(KM_PER_NM).toBe(1.852);
  });
});
