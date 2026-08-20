import { haversineKm, bearingDeg, KM_PER_NM } from './geo';
import { etaMinutes, formatEta } from './eta';
import { matchSchedule } from './join';
import { airlineName } from './airlines';
import type { Aircraft, Flight, ScheduleRow } from './types';

export interface EnrichOptions {
  units: 'imperial' | 'metric';
  /** Used only when the position feed did not precompute distance/bearing. */
  centerLat?: number;
  centerLon?: number;
}

const FT_PER_M = 3.28084;
const KMH_PER_KT = 1.852;

/**
 * One aircraft plus the schedule -> one display-ready flight, or null to drop it.
 *
 * A schedule miss is NOT a failure: the flight still renders with its callsign,
 * position and live metrics, just without a route. That is the whole design
 * stance — blank beats a confident wrong city on a 64px panel.
 */
export function enrich(a: Aircraft, rows: readonly ScheduleRow[], opts: EnrichOptions): Flight | null {
  const cs = a.callsign.trim();
  if (!cs) return null; // no identity, not worth a slot

  const row = matchSchedule(cs, a.lat, a.lon, rows);

  let etaMin: number | null = null;
  let etaText: string | null = null;
  if (row && row.destLat !== null && row.destLon !== null) {
    const nm = haversineKm(a.lat, a.lon, row.destLat, row.destLon) / KM_PER_NM;
    etaMin = etaMinutes(nm, a.groundspeedKt ?? Number.NaN);
    etaText = formatEta(nm, etaMin);
  }

  // Prefer the feed's precomputed values; adsb.lol ships both, so this
  // fallback is for sources that don't.
  let dstNm = a.distanceNm;
  let brg = a.bearingDeg;
  if (opts.centerLat !== undefined && opts.centerLon !== undefined) {
    if (dstNm === null) dstNm = haversineKm(opts.centerLat, opts.centerLon, a.lat, a.lon) / KM_PER_NM;
    if (brg === null) brg = bearingDeg(opts.centerLat, opts.centerLon, a.lat, a.lon);
  }

  const metric = opts.units === 'metric';
  const round = (v: number | null): number | null => (v === null ? null : Math.round(v));

  return {
    cs,
    flt: row ? `${row.carrierIata}${row.number}` : null,
    al: row ? airlineName(row.carrierIata) ?? row.carrierIata : null,
    reg: a.registration,
    ac: a.typeIcao,
    from: row?.origIata ?? null,
    to: row?.destIata ?? null,
    alt: round(a.altFt === null ? null : metric ? a.altFt / FT_PER_M : a.altFt),
    spd: round(a.groundspeedKt === null ? null : metric ? a.groundspeedKt * KMH_PER_KT : a.groundspeedKt),
    hdg: round(a.trackDeg),
    vs: round(a.verticalRateFpm === null ? null : metric ? a.verticalRateFpm / FT_PER_M : a.verticalRateFpm),
    // One decimal: the panel shows "12.4" but never "12.437".
    dst: dstNm === null ? 0 : Math.round((metric ? dstNm * KM_PER_NM : dstNm) * 10) / 10,
    brg: brg === null ? 0 : Math.round(brg),
    eta_min: round(etaMin),
    eta_text: etaText,
    eta_src: etaMin === null ? null : 'physics',
  };
}
