import { describe, it, expect } from 'vitest';
import { greatCircleAt, deadReckonAt } from '../../src/tracked/deadReckon';

const JFK = { lat: 40.6413, lon: -73.7781 };
const LHR = { lat: 51.47, lon: -0.4543 };

describe('greatCircleAt', () => {
  it('returns the endpoints at the extremes', () => {
    expect(greatCircleAt(JFK, LHR, 0).lat).toBeCloseTo(JFK.lat, 4);
    expect(greatCircleAt(JFK, LHR, 0).lon).toBeCloseTo(JFK.lon, 4);
    expect(greatCircleAt(JFK, LHR, 1).lat).toBeCloseTo(LHR.lat, 4);
    expect(greatCircleAt(JFK, LHR, 1).lon).toBeCloseTo(LHR.lon, 4);
  });

  it('bows NORTH of both endpoints at the midpoint', () => {
    // The distinguishing property of a great circle versus naive linear
    // interpolation: the JFK-LHR midpoint is north of BOTH airports. Linear
    // interpolation would put it at ~46N, between them, and would look
    // plausible while being wrong by hundreds of miles.
    const mid = greatCircleAt(JFK, LHR, 0.5);
    expect(mid.lat).toBeGreaterThan(LHR.lat);
    expect(mid.lat).toBeLessThan(60);
    expect(mid.lon).toBeGreaterThan(-45);
    expect(mid.lon).toBeLessThan(-25);
  });

  it('clamps a fraction outside 0..1 rather than extrapolating', () => {
    // Past the destination is not a place the aircraft can be.
    expect(greatCircleAt(JFK, LHR, 1.5).lat).toBeCloseTo(LHR.lat, 4);
    expect(greatCircleAt(JFK, LHR, -0.5).lat).toBeCloseTo(JFK.lat, 4);
  });

  it('handles identical endpoints without dividing by zero', () => {
    const p = greatCircleAt(JFK, JFK, 0.5);
    expect(p.lat).toBeCloseTo(JFK.lat, 4);
    expect(p.lon).toBeCloseTo(JFK.lon, 4);
  });
});

describe('deadReckonAt', () => {
  const dep = Date.UTC(2026, 8, 14, 18, 0, 0);
  const arr = Date.UTC(2026, 8, 15, 1, 0, 0); // 7h later
  const route = { orig: JFK, dest: LHR, depMs: dep, arrMs: arr };

  it('is at the origin at departure and the destination at arrival', () => {
    expect(deadReckonAt(route, dep)!.lat).toBeCloseTo(JFK.lat, 3);
    expect(deadReckonAt(route, arr)!.lat).toBeCloseTo(LHR.lat, 3);
  });

  it('is north of both airports halfway through', () => {
    const p = deadReckonAt(route, dep + 3.5 * 3600_000)!;
    expect(p.lat).toBeGreaterThan(LHR.lat);
  });

  it('clamps outside the flight window instead of extrapolating', () => {
    expect(deadReckonAt(route, dep - 3600_000)!.lat).toBeCloseTo(JFK.lat, 3);
    expect(deadReckonAt(route, arr + 3600_000)!.lat).toBeCloseTo(LHR.lat, 3);
  });

  it('returns null when the route is not fully known', () => {
    // Refusing is the point: a half-known route must produce no position at
    // all rather than a confident-looking guess.
    expect(deadReckonAt({ ...route, orig: null }, dep + 3600_000)).toBeNull();
    expect(deadReckonAt({ ...route, dest: null }, dep + 3600_000)).toBeNull();
    expect(deadReckonAt({ ...route, depMs: null }, dep + 3600_000)).toBeNull();
    expect(deadReckonAt({ ...route, arrMs: null }, dep + 3600_000)).toBeNull();
  });

  it('returns null for a zero or negative duration', () => {
    expect(deadReckonAt({ ...route, arrMs: dep }, dep)).toBeNull();
    expect(deadReckonAt({ ...route, arrMs: dep - 1 }, dep)).toBeNull();
  });
});
