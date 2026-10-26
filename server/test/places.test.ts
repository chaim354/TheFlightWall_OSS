import { describe, it, expect } from 'vitest';
import { nearestPlace, OVER_KM, NEAR_KM } from '../src/places';
import { PLACE_ROWS } from '../src/places.data';

describe('nearestPlace', () => {
  it('names the town under the aircraft, with its state', () => {
    // Downtown Springfield, IL.
    const p = nearestPlace(39.80, -89.65)!;
    expect(p.name).toBe('Springfield');
    expect(p.region).toBe('IL');
    expect(p.near).toBe(false);
    expect(p.km).toBeLessThan(OVER_KM);
  });

  it('writes Canadian and Australian regions as people do, not as GeoNames numbers them', () => {
    expect(nearestPlace(43.65, -79.38)!.region).toBe('ON');
    expect(nearestPlace(-33.87, 151.21)!.region).toBe('NSW');
  });

  it('falls back to the country elsewhere, shortened where it would eat the row', () => {
    expect(nearestPlace(45.76, 4.84)).toMatchObject({ name: 'Lyon', region: 'France' });
    expect(nearestPlace(51.51, -0.13)!.region).toBe('UK');
  });

  it('says "near" between OVER_KM and NEAR_KM', () => {
    // Gander, NL is at 48.95N 54.61W; a point ~60km east of it, offshore.
    const p = nearestPlace(48.95, -53.80)!;
    expect(p.near).toBe(true);
    expect(p.km).toBeGreaterThan(OVER_KM);
    expect(p.km).toBeLessThanOrEqual(NEAR_KM);
  });

  it('is null in mid-ocean rather than naming a town hundreds of miles away', () => {
    expect(nearestPlace(45.0, -40.0)).toBeNull();
  });

  it('finds a town across the antimeridian', () => {
    // Just east of 180 in Fiji; Labasa is at 16.43S 179.38E, ~70km away.
    const p = nearestPlace(-16.6, -179.95);
    expect(p).not.toBeNull();
    expect(p!.km).toBeLessThanOrEqual(NEAR_KM);
  });

  it('agrees with a brute-force scan of the whole table', () => {
    // The grid is an optimisation and nothing else: it must never change the
    // answer. A spread of points, including high latitude where the longitude
    // span widens.
    const points: Array<[number, number]> = [
      [40.0, -100.0], [64.8, -147.7], [69.6, 18.9], [-23.5, -46.6], [35.7, 139.7], [1.3, 103.8],
    ];
    const rad = (d: number) => (d * Math.PI) / 180;
    const km = (aLat: number, aLon: number, bLat: number, bLon: number) => {
      const h = Math.sin(rad(bLat - aLat) / 2) ** 2 +
        Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLon - aLon) / 2) ** 2;
      return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
    };
    for (const [lat, lon] of points) {
      let best = Infinity;
      let name = '';
      for (const row of PLACE_ROWS) {
        const [n, , la, lo] = row.split('\t');
        const d = km(lat, lon, Number(la), Number(lo));
        if (d < best) { best = d; name = n!; }
      }
      const p = nearestPlace(lat, lon);
      if (best > NEAR_KM) expect(p).toBeNull();
      else expect(p?.name).toBe(name);
    }
  });

  it('is null for a position that is not one', () => {
    expect(nearestPlace(Number.NaN, 0)).toBeNull();
    expect(nearestPlace(91, 0)).toBeNull();
  });

  it('every row is ASCII, so the panel font can draw it', () => {
    for (const row of PLACE_ROWS) expect(row).toMatch(/^[\x20-\x7e]+\t[^\t]+\t-?\d+\.\d\d\t-?\d+\.\d\d$/);
  });
});
