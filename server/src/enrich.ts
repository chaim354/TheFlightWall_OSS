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
 * An arrival epoch counts as a usable source only if it is still ahead of
 * now. A revised or scheduled arrival in the past means the record is
 * stale -- the flight has already landed by the operator's own account (a
 * runwayTime would confirm it, but we don't fetch that), or the row simply
 * never got updated. Either way it is not a source for a FUTURE eta, so it
 * is treated exactly as if it had never been supplied and the chain moves
 * on to the next candidate, rather than surfacing a zero or negative
 * number. `>=` (not `>`) so an epoch equal to `nowSec` -- arriving this
 * instant -- still counts: that is a real (zero-minute) answer, not a stale
 * one.
 */
function futureEpoch(epochSec: number | null, nowSec: number): number | null {
  return epochSec !== null && epochSec >= nowSec ? epochSec : null;
}

/**
 * One aircraft plus the schedule -> one display-ready flight, or null to drop it.
 *
 * A schedule miss is NOT a failure: the flight still renders with its callsign,
 * position and live metrics, just without a route. That is the whole design
 * stance — blank beats a confident wrong city on a 64px panel.
 *
 * `nowMs` is threaded in rather than read via Date.now() inside this
 * function: enrich() is pure and unit-tested (like eta.ts), and reaching for
 * the wall clock here would make "what did this return for this input" a
 * question with no fixed answer.
 */
export function enrich(a: Aircraft, rows: readonly ScheduleRow[], opts: EnrichOptions, nowMs: number): Flight | null {
  const cs = a.callsign.trim();
  if (!cs) return null; // no identity, not worth a slot

  const row = matchSchedule(cs, a.lat, a.lon, rows);

  let etaMin: number | null = null;
  let etaText: string | null = null;
  let etaSrc: Flight['eta_src'] = null;

  if (row) {
    const nowSec = nowMs / 1000;

    // Priority chain -- a real arrival time beats any model, because it
    // already accounts for climb, cruise, descent, routing, taxi and the
    // actual delay (see eta.ts's own header comment on everything the
    // physics model can't know). Revised beats scheduled because it is the
    // delay-aware figure; either beats physics because a schedule entry is
    // a fact about a plan, not a guess about the future. Physics remains
    // the fallback: it runs when neither time is usable below.
    const revEpoch = futureEpoch(row.revArrEpoch, nowSec);
    const schedEpoch = futureEpoch(row.schedArrEpoch, nowSec);
    const arrivalEpoch = revEpoch ?? schedEpoch;

    // Distance to destination, when the row has coordinates for it. Needed
    // for the physics model, and ALSO for formatEta's LANDING/rounding
    // contract regardless of which source produced etaMin -- that display
    // contract does not change with the source, only the number it is
    // applied to. NaN when coordinates are missing; formatEta already
    // treats a non-finite distance as "cannot confirm LANDING by proximity"
    // and falls through to its ordinary rounding, so this needs no extra
    // branching here.
    const nm = row.destLat !== null && row.destLon !== null
      ? haversineKm(a.lat, a.lon, row.destLat, row.destLon) / KM_PER_NM
      : Number.NaN;

    if (arrivalEpoch !== null) {
      etaMin = (arrivalEpoch - nowSec) / 60;
      etaSrc = revEpoch !== null ? 'revised' : 'scheduled';
    } else if (row.destLat !== null && row.destLon !== null) {
      // a.altFt is always feet (source units), independent of opts.units --
      // the metric conversion below only affects the *displayed* alt field,
      // not this value, so the descent floor never needs converting.
      etaMin = etaMinutes(nm, a.groundspeedKt ?? Number.NaN, a.altFt);
      etaSrc = etaMin === null ? null : 'physics';
    }

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
    // etaSrc is already kept in lock-step with etaMin above (set alongside
    // it in every branch, including the null ones), so no extra guard is
    // needed here the way the old physics-only line needed `etaMin === null
    // ? null : 'physics'`.
    eta_src: etaSrc,
  };
}
