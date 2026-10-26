// Hand-owned. The 70,000-row place table this reads lives in ./places.data.ts,
// which IS generated -- see tools/gen-places.js. Keeping the lookup out of the
// generated module is the same rule ./schedule/airports.ts follows, for the
// same reason: a regeneration must never be able to delete logic.
//
// Imported by server.ts ONLY, and handed to the flights handler as
// Env.PLACES. The Worker shares flights.ts and tracked/serve.ts but has no
// tracked store, so it never needs this -- and importing it from either of
// those files would put 2.5MB of towns into a bundle that cannot use them.

import { PLACE_ROWS } from './places.data';
import { haversineKm } from './geo';

/**
 * Within this, an aircraft is "over" the town.
 *
 * Generous, deliberately. From cruise altitude the town is a smudge a few
 * miles across and the aircraft is seven miles above it; nobody on board or on
 * the ground means "directly overhead to the nearest hundred metres" by it.
 * 25km is roughly the spacing of towns of this size in settled country, so
 * "over" is the normal answer there and "near" the normal one in open land.
 */
export const OVER_KM = 25;

/**
 * Beyond OVER_KM and within this, the aircraft is "near" the town. Beyond it,
 * there is no honest answer and the lookup returns null.
 *
 * NOT "over the ocean": the table holds towns, not coastlines, and it cannot
 * tell 160km of sea from 160km of desert. Saying nothing is the one claim that
 * is true of both.
 */
export const NEAR_KM = 150;

export interface NearbyPlace {
  name: string;
  /** State/province abbreviation for US/CA/AU, else the country. */
  region: string;
  km: number;
  /** True when beyond OVER_KM: "near", not "over". */
  near: boolean;
}

export type PlaceLookup = (lat: number, lon: number) => NearbyPlace | null;

interface Index {
  names: string[];
  regions: string[];
  lats: Float64Array;
  lons: Float64Array;
  /** 1-degree cells, keyed (floor(lat)+90)*360 + (floor(lon)+180). */
  cells: Map<number, number[]>;
}

let index: Index | null = null;

const cellKey = (latCell: number, lonCell: number): number => (latCell + 90) * 360 + lonCell + 180;

/** Built on first use, so a server that never serves a tracked card never pays for it. */
function getIndex(): Index {
  if (index) return index;
  const n = PLACE_ROWS.length;
  const built: Index = {
    names: new Array<string>(n),
    regions: new Array<string>(n),
    lats: new Float64Array(n),
    lons: new Float64Array(n),
    cells: new Map(),
  };
  for (let i = 0; i < n; i++) {
    const [name, region, lat, lon] = PLACE_ROWS[i]!.split('\t');
    built.names[i] = name!;
    built.regions[i] = region!;
    built.lats[i] = Number(lat);
    built.lons[i] = Number(lon);
    const key = cellKey(Math.floor(built.lats[i]!), Math.floor(built.lons[i]!));
    const bucket = built.cells.get(key);
    if (bucket) bucket.push(i);
    else built.cells.set(key, [i]);
  }
  index = built;
  return built;
}

/**
 * The nearest town to a position, if any is within NEAR_KM.
 *
 * Scans only the 1-degree cells that can hold something within NEAR_KM: two
 * degrees of latitude either way (one degree is ~111km), and as many of
 * longitude as that distance spans at this latitude -- which widens toward the
 * poles, so it is computed from the cell edge nearer the pole rather than the
 * position, and capped at the whole circle. Longitude wraps, so a flight over
 * the antimeridian finds Fiji on both sides of it.
 */
export function nearestPlace(lat: number, lon: number): NearbyPlace | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null;
  const idx = getIndex();

  const latSpan = Math.ceil(NEAR_KM / 111);
  const latCell = Math.floor(lat);
  const lonCell = Math.floor(((((lon + 180) % 360) + 360) % 360) - 180);

  let best = -1;
  let bestKm = Infinity;
  for (let dLat = -latSpan; dLat <= latSpan; dLat++) {
    const c = latCell + dLat;
    if (c < -90 || c > 89) continue;
    const poleward = Math.min(89.9, Math.max(Math.abs(c), Math.abs(c + 1)));
    const kmPerLonDeg = 111 * Math.cos((poleward * Math.PI) / 180);
    const lonSpan = Math.min(180, Math.ceil(NEAR_KM / Math.max(kmPerLonDeg, 1e-6)));
    for (let dLon = -lonSpan; dLon <= lonSpan; dLon++) {
      const wrapped = ((((lonCell + dLon + 180) % 360) + 360) % 360) - 180;
      const bucket = idx.cells.get(cellKey(c, wrapped));
      if (!bucket) continue;
      for (const i of bucket) {
        const km = haversineKm(lat, lon, idx.lats[i]!, idx.lons[i]!);
        if (km < bestKm) {
          bestKm = km;
          best = i;
        }
      }
      // A span of 180 already covers every cell; stepping on would revisit them.
      if (lonSpan === 180 && dLon === 179) break;
    }
  }

  if (best < 0 || bestKm > NEAR_KM) return null;
  return {
    name: idx.names[best]!,
    region: idx.regions[best]!,
    km: Math.round(bestKm * 10) / 10,
    near: bestKm > OVER_KM,
  };
}
