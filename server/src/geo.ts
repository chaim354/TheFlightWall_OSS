// Pure geometry. No Workers APIs, no I/O — unit-tested with plain vitest.

/** Mean Earth radius (IUGG), km. */
export const R_KM = 6371.0088;

/** International nautical mile, km. */
export const KM_PER_NM = 1.852;

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = toRad(aLat);
  const p2 = toRad(bLat);
  const dp = p2 - p1;
  // Taking the delta in degrees before converting keeps antimeridian
  // crossings correct: 179 -> -179 is -358 deg, whose sine is that of +2 deg.
  const dl = toRad(bLon - aLon);
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing, degrees clockwise from north, in [0, 360). */
export function bearingDeg(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const p1 = toRad(fromLat);
  const p2 = toRad(toLat);
  const dl = toRad(toLon - fromLon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * How far off the direct A->B path a point sits, in km: d(P,A) + d(P,B) - d(A,B).
 *
 * Zero on the route, large off it. This is the cheap test that catches a
 * geometrically impossible route claim — measured on live data, it rejected
 * 6 of 17 wrong destinations with zero false positives, including a flight
 * reported as SFO-LAX while physically over New York.
 *
 * It is a detour metric, NOT cross-track distance: a point beyond an endpoint
 * scores high, which is what we want (an aircraft 500 km past its claimed
 * destination is as suspect as one 500 km to the side).
 *
 * Clamped at zero — floating-point error can otherwise produce a tiny negative
 * for a point exactly on the path.
 */
export function corridorExcessKm(
  pLat: number, pLon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): number {
  const legs = haversineKm(pLat, pLon, aLat, aLon) + haversineKm(pLat, pLon, bLat, bLon);
  return Math.max(0, legs - haversineKm(aLat, aLon, bLat, bLon));
}
