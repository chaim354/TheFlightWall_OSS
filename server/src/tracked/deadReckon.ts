import type { LatLon } from './types';

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Point at `fraction` along the great circle from `a` to `b`.
 *
 * Spherical linear interpolation, NOT linear interpolation of lat/lon. On a
 * JFK-LHR route the two differ by hundreds of miles at the midpoint -- the real
 * track bows north of both airports, which is why the aircraft is over Iceland
 * rather than mid-Atlantic. Since this position is already an estimate, using
 * the wrong curve would compound an approximation with an avoidable error.
 *
 * `fraction` is clamped: past the destination is not a place an aircraft can be.
 */
export function greatCircleAt(a: LatLon, b: LatLon, fraction: number): LatLon {
  const f = clamp01(fraction);
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lon);

  const δ = 2 * Math.asin(
    Math.sqrt(
      Math.sin((φ2 - φ1) / 2) ** 2 +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
    ),
  );

  // Coincident endpoints: sin(δ) is 0 and the interpolation below would divide
  // by zero. There is also nothing to interpolate.
  if (δ === 0 || !Number.isFinite(δ)) return { lat: a.lat, lon: a.lon };

  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);

  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);

  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lon: toDeg(Math.atan2(y, x)),
  };
}

export interface DeadReckonRoute {
  orig: LatLon | null;
  dest: LatLon | null;
  depMs: number | null;
  arrMs: number | null;
}

/**
 * Estimated position from schedule alone, or null when it cannot be estimated.
 *
 * Returning null on partial input is deliberate. Every caller of this labels
 * the result `pos_src: "estimated"`, but a position derived from half a route
 * would be worse than that label admits -- so the only honest output for
 * incomplete input is no output. Assumes constant progress along the track,
 * which is wrong in detail (climb, cruise, descent, winds) and right enough for
 * "roughly where over the ocean is it".
 */
export function deadReckonAt(route: DeadReckonRoute, nowMs: number): LatLon | null {
  const { orig, dest, depMs, arrMs } = route;
  if (!orig || !dest || depMs === null || arrMs === null) return null;
  const duration = arrMs - depMs;
  if (duration <= 0) return null;
  return greatCircleAt(orig, dest, (nowMs - depMs) / duration);
}
