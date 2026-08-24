import { deadReckonAt } from './deadReckon';
import { haversineKm, bearingDeg, KM_PER_NM } from '../geo';
import { airlineName } from '../airlines';
import { formatEta } from '../eta';
import type { TrackedEntry } from './types';

/**
 * How long a fix stays servable as "live".
 *
 * MUST EXCEED the poll interval in server.ts (`TRACKED_TICK_MS`, currently
 * 300s) with margin, and the two are coupled even though they live in
 * different files. When they were equal, a fix reached this boundary exactly as
 * the next poll was due, so any late tick or single failed poll relabelled a
 * perfectly good position as an estimate and the card oscillated between the
 * two while nothing was actually wrong.
 *
 * 11 minutes is a little over TWO polls: one miss is a timing wobble and the
 * last fix is still the best thing we know, while two consecutive misses are a
 * real loss of ADS-B coverage -- which is precisely when "we are projecting"
 * becomes the honest answer. If you change TRACKED_TICK_MS, change this too.
 */
const FIX_FRESH_MS = 11 * 60_000;

/**
 * A pinned card, alongside an ordinary area card (see src/types.ts's Flight,
 * the wire-shape contract that comment describes in full). Deliberately the
 * SAME fields, same units, same semantics, so the device renders a pinned
 * card identically to an area one apart from the pin marker -- it has no
 * separate rendering path for "tracked", only a `pin`/`pos_src` flag it reads
 * in addition to the ordinary fields.
 *
 * This used to carry only cs/flt/reg/from/to/lat/lon/pin/pos_src, which is
 * why a pinned card rendered blank on the wall: callsign and route only, no
 * altitude, speed, distance, ETA, airline or aircraft type. `lat`/`lon` are
 * gone entirely now -- FlightWallServerFetcher.cpp never parsed them (it has
 * no use for a raw coordinate, only distance/bearing from the wall), so they
 * were dead weight on the wire, not a fallback for anything.
 */
export interface TrackedCard {
  cs: string;
  flt: string;
  al: string | null;
  reg: string | null;
  ac: string | null;
  from: string | null;
  to: string | null;
  alt: number | null;
  spd: number | null;
  hdg: number | null;
  vs: number | null;
  dst: number;
  brg: number;
  eta_min: number | null;
  eta_text: string | null;
  eta_src: 'revised' | 'scheduled' | 'physics' | null;
  pin: true;
  pos_src: 'live' | 'estimated';
}

/**
 * Carrier prefix of a normalised tracked flight number ("BA181" -> "BA"), to
 * key airlineName() the same way enrich.ts does from a schedule row's
 * carrierIata.
 *
 * A tracked entry has no separate carrier field the way a ScheduleRow does --
 * routes.ts's normaliseNumber already established that `number` IS "carrier
 * prefix + digits" before an entry is ever stored (2-3 alphanumerics with at
 * least one letter, then 1-4 digits) -- so the prefix is recovered here the
 * same way join.ts's callsignKey recovers a flight number from a live ADS-B
 * callsign: take the TRAILING digit run as the number and whatever is left as
 * the prefix, rather than matching the prefix greedily from the front.
 * `/^[A-Z0-9]{2,3}\d{1,4}$/` looks like the obvious regex, but on "BA181" its
 * greedy `{2,3}` happily consumes "BA1" and leaves only "81" for the digits --
 * regex has no notion that a carrier code stops being alphanumeric and starts
 * being numeric, only character classes -- which would send "BA1" into
 * airlineName() and silently render a known carrier as unknown.
 */
function carrierPrefix(number: string): string | null {
  const m = /(\d+)$/.exec(number);
  if (!m || !m[1]) return null;
  const prefix = number.slice(0, number.length - m[1].length);
  return prefix.length >= 2 && prefix.length <= 3 ? prefix : null;
}

/**
 * Cards for the flights currently in the air, pinned.
 *
 * `pos_src` is the load-bearing field. A dead-reckoned position is a schedule
 * projection, not an observation, and serving it indistinguishably from a fix
 * would be the plausible-looking-wrong-value failure this codebase already
 * guards against in clearStaleFlights and the ok:false propagation. The device
 * renders the two differently.
 *
 * An entry with neither a fresh fix nor a complete route yields NO card, rather
 * than a card at a default position.
 *
 * `center` is the requesting board's own position -- the same "where is the
 * panel" input enrich.ts takes as `opts.center` -- because `dst`/`brg` are
 * measured FROM the wall, exactly like an area card's, not from anywhere else.
 */
export function trackedCards(
  entries: TrackedEntry[],
  nowMs: number,
  center: { lat: number; lon: number },
): TrackedCard[] {
  const cards: TrackedCard[] = [];

  for (const e of entries) {
    if (e.state !== 'airborne') continue;

    const fresh =
      e.lastLat !== null && e.lastLon !== null && e.lastPosAtMs !== null &&
      nowMs - e.lastPosAtMs <= FIX_FRESH_MS;

    let lat: number | null = null;
    let lon: number | null = null;
    let src: 'live' | 'estimated' = 'live';

    if (fresh) {
      lat = e.lastLat;
      lon = e.lastLon;
    } else {
      const p = deadReckonAt(
        {
          orig: e.orig,
          dest: e.dest,
          depMs: e.schedDepEpoch === null ? null : e.schedDepEpoch * 1000,
          arrMs: e.schedArrEpoch === null ? null : e.schedArrEpoch * 1000,
        },
        nowMs,
      );
      if (!p) continue;
      lat = p.lat;
      lon = p.lon;
      src = 'estimated';
    }

    if (lat === null || lon === null) continue;

    // Distance/bearing FROM THE WALL, same formula and units as enrich.ts:
    // `dst` is NAUTICAL MILES (one decimal), not km. The firmware
    // (FlightWallServerFetcher.cpp) multiplies `dst` by 1.852 to get km it can
    // display, with its own comment warning that skipping the conversion
    // shows every flight at roughly half its true distance -- serving km here
    // would silently trigger exactly that.
    const dstNm = haversineKm(center.lat, center.lon, lat, lon) / KM_PER_NM;
    const brg = bearingDeg(center.lat, center.lon, lat, lon);

    // ETA, from the SCHEDULE only. A tracked entry never carries a revised
    // (delay-aware) arrival -- ResolvedFlight only has AeroDataBox's
    // scheduled time -- so 'physics' and 'revised' can never apply here, only
    // 'scheduled', an existing value in Flight['eta_src']'s vocabulary
    // (src/types.ts). Floored at 0 rather than going negative once the
    // scheduled arrival is in the past (a delayed/overdue flight whose
    // OpenSky poll hasn't yet reported landed).
    let etaMinRaw: number | null = null;
    let etaSrc: TrackedCard['eta_src'] = null;
    if (e.schedArrEpoch !== null) {
      etaMinRaw = Math.max(0, (e.schedArrEpoch * 1000 - nowMs) / 60000);
      etaSrc = 'scheduled';
    }

    // formatEta's first argument decides LANDING by proximity, and it MUST be
    // distance to this flight's own DESTINATION, not distance to the wall
    // (dstNm above) -- a tracked flight is pinned worldwide and routinely
    // passes near the wall early in its journey, long before landing. Only
    // computable with destination coordinates; NaN (like enrich.ts's own `nm`
    // when a schedule row has no destination) falls through to formatEta's
    // ordinary rounding rather than claiming LANDING on nothing.
    const nmToDest = e.dest !== null
      ? haversineKm(lat, lon, e.dest.lat, e.dest.lon) / KM_PER_NM
      : Number.NaN;
    const etaText = formatEta(nmToDest, etaMinRaw);

    const prefix = carrierPrefix(e.number);

    cards.push({
      cs: e.number,
      flt: e.number,
      al: prefix ? airlineName(prefix) : null,
      reg: e.reg,
      ac: e.aircraftModel,
      from: e.origIata,
      to: e.destIata,
      alt: e.lastAltFt,
      spd: e.lastGroundspeedKt,
      hdg: e.lastHeadingDeg,
      vs: e.lastVerticalRateFpm,
      // One decimal, same as enrich.ts: the panel shows "12.4", never "12.437".
      dst: Math.round(dstNm * 10) / 10,
      brg: Math.round(brg),
      eta_min: etaMinRaw === null ? null : Math.round(etaMinRaw),
      eta_text: etaText,
      eta_src: etaSrc,
      pin: true,
      pos_src: src,
    });
  }

  return cards;
}
