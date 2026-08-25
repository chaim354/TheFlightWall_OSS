/**
 * ICAO type code for a transponder hex, from hexdb.io.
 *
 * WHY THIS EXISTS. A pinned card and an area card were naming the same thing in
 * two different vocabularies: an area card carries adsb.lol's `typeIcao`
 * ("B752"), while a pinned card carried AeroDataBox's `aircraft.model`, a
 * marketing string ("Boeing 757-200", or "Boeing 777-300ER Passenger", which
 * the panel then cut to "Boeing 777-300" and lost the ER). AeroDataBox's
 * by-number payload has no type code in it at all, so matching the rest of the
 * carousel means asking somewhere else.
 *
 * hexdb.io is the natural somewhere: free, keyless, and already a source this
 * project depends on -- the device's own adsbdb fetcher reads `ICAOTypeCode`
 * off this exact endpoint (see firmware/adapters/AdsbdbFetcher.cpp). Keyed on
 * the hex, which the resolve step has already paid AeroDataBox for.
 *
 * ONE CALL PER TRACKED FLIGHT, at resolve time, not per render and not per
 * tick: a given journey's airframe is fixed once the tail is known, and the
 * answer is stored on the entry. A re-resolve (the single tail-swap check
 * before departure) does spend a second one, which is correct -- a swapped tail
 * is a different aircraft and may well be a different type.
 *
 * NEVER THROWS, AND NEVER FAILS A RESOLVE. A type code is a nicety; the flight,
 * its route and its position are the point. Every failure path returns null and
 * the caller keeps AeroDataBox's model name, which is what shipped before this
 * existed. That is also why this is not folded into resolveFlight's own error
 * handling: a hexdb outage must not make a flight unresolvable.
 */

const BASE = 'https://hexdb.io/api/v1/aircraft';

/**
 * How long to wait before giving up.
 *
 * Short on purpose. This runs inside the tracked tick, which processes entries
 * in sequence, so a hung request here delays every entry behind it -- and the
 * thing being waited for is a cosmetic improvement to one line of one card.
 * Better to render the model name than to hold up a position poll.
 */
const TIMEOUT_MS = 4000;

/** Uppercase ICAO type code (e.g. "B752"), or null if it cannot be had. */
export async function fetchIcaoTypeCode(hex: string): Promise<string | null> {
  if (!hex) return null;

  let res: Response;
  try {
    res = await fetch(`${BASE}/${encodeURIComponent(hex)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null; // transport failure or timeout -- see the header
  }

  if (!res.ok) return null;

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return null;
  }

  // hexdb answers an unknown hex with 200 and a body that simply has no
  // ICAOTypeCode, rather than a 404, so the shape check below IS the
  // not-found path and not merely defensive typing.
  const code = (payload as { ICAOTypeCode?: unknown } | null)?.ICAOTypeCode;
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}
