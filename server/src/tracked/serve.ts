import { deadReckonAt } from './deadReckon';
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

export interface TrackedCard {
  cs: string;
  flt: string;
  reg: string | null;
  from: string | null;
  to: string | null;
  lat: number;
  lon: number;
  pin: true;
  pos_src: 'live' | 'estimated';
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
 */
export function trackedCards(entries: TrackedEntry[], nowMs: number): TrackedCard[] {
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

    cards.push({
      cs: e.number,
      flt: e.number,
      reg: e.reg,
      from: e.origIata,
      to: e.destIata,
      lat,
      lon,
      pin: true,
      pos_src: src,
    });
  }

  return cards;
}
