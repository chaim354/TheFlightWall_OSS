import { BOARD_AIRPORTS, FAR_AIRPORT_COORDS } from './airports';
import type { ScheduleRow } from '../types';

/**
 * Parse an AeroDataBox FIDS response into schedule rows.
 *
 * ADAPTED FROM THE PLAN'S SKETCH to the shape the live endpoint actually
 * returns (verified against server/fixtures/fids-kjfk.json, 261 rows captured
 * live). The plan's sketch assumed a single `movement: { airport, ... }`
 * object per row; the real shape has no `movement` key at all. Every row --
 * whether it came from the top-level `arrivals` or `departures` array --
 * carries its own `departure` AND `arrival` sub-objects:
 *
 *   { departure: { airport?, scheduledTime, terminal, ... },
 *     arrival:   { airport?, scheduledTime, terminal, ... },
 *     number: "DL 4984", callSign: "EDV4984" | undefined,
 *     status, codeshareStatus, isCargo,
 *     aircraft: { reg, modeS, model }, airline: { name, iata, icao } }
 *
 * Only ONE side carries an `airport` sub-object: the far end. The near end
 * (this board's own airport) is implicit -- confirmed by inspecting every row
 * in the fixture, so `BOARD_AIRPORTS` supplies it, exactly as the plan says.
 *
 * The `arrivals`/`departures` array a row came from still tells you which
 * side is which: for an `arrivals`-array row, `departure` is the far end and
 * `arrival` is this board; for `departures`, it is the reverse. That much of
 * the plan's asymmetry holds. What differs is that "the scheduled arrival
 * time" doesn't need a direction branch at all -- the JSON's own `arrival`
 * key already means "the leg's arrival," at whichever airport that is, so
 * `schedArrEpoch` is always `row.arrival.scheduledTime.utc` regardless of
 * which array the row came from.
 *
 * Never throws: a malformed payload, a malformed row, or a row with a
 * wrong-typed field degrades to skipping that row (or that field), never to
 * throwing -- same discipline as adsblol.ts's `str()` guard, and for the same
 * reason: one bad row must not cost the caller the whole board.
 */
export function parseFids(body: unknown, airportIcao: string): ScheduleRow[] {
  const b = body as { arrivals?: unknown; departures?: unknown };
  const out: ScheduleRow[] = [];
  collect(b?.arrivals, airportIcao, 'arrival', out);
  collect(b?.departures, airportIcao, 'departure', out);
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * `Date.parse` on FIDS's `"2026-08-20 10:30Z"` format (a space, not the ISO
 * "T", between date and time) -- verified under V8 (the engine both Node and
 * Cloudflare Workers use) to parse identically to the "T" form. Still guarded
 * here rather than trusted blindly: a malformed or missing timestamp must
 * degrade to null, not to `Date.parse`'s NaN silently propagating as a number.
 */
const epoch = (s: unknown): number | null => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

function collect(
  list: unknown,
  airportIcao: string,
  dir: 'arrival' | 'departure',
  out: ScheduleRow[],
): void {
  if (!Array.isArray(list)) return;
  const self = BOARD_AIRPORTS[airportIcao.toUpperCase()];
  if (!self) return; // a board we have no coordinates for cannot be checked

  const isArrival = dir === 'arrival';

  for (const m of list as Record<string, unknown>[]) {
    const numberStr = str(m?.number).replace(/\s+/g, '');
    const digits = /(\d+)$/.exec(numberStr)?.[1];
    if (!digits) continue; // no derivable flight number -- cannot index this row

    const airline = m?.airline as Record<string, unknown> | undefined;
    const carrier = str(airline?.iata) || numberStr.slice(0, numberStr.length - digits.length);
    if (!carrier) continue;

    // The far end is whichever side ("departure" for an arrivals-array row,
    // "arrival" for a departures-array row) carries the `airport` object.
    const far = (isArrival ? m?.departure : m?.arrival) as Record<string, unknown> | undefined;
    const farAirport = far?.airport as Record<string, unknown> | undefined;
    const farIcao = str(farAirport?.icao).toUpperCase() || null;
    const farIata = str(farAirport?.iata) || null;
    // FIDS carries no coordinates for either end (verified: neither `lat`,
    // `lon`, nor `location` appears anywhere in the captured fixture). The
    // far end's coordinates come from a table built by looking each one up
    // separately -- see airports.ts for how and its documented coverage gap.
    const farCoord = farIcao ? FAR_AIRPORT_COORDS[farIcao] : undefined;

    // The row's own `arrival` sub-object is always the scheduled arrival --
    // at this board for an arrivals-array row, at the far end for a
    // departures-array row -- so no direction branch is needed here.
    const arrivalSide = m?.arrival as Record<string, unknown> | undefined;
    const arrivalTime = arrivalSide?.scheduledTime as Record<string, unknown> | undefined;

    out.push({
      callsign: str(m?.callSign) || null,
      carrierIata: carrier.toUpperCase(),
      number: digits.replace(/^0+/, '') || '0',
      origIata: isArrival ? farIata : self.iata,
      origLat: isArrival ? farCoord?.lat ?? null : self.lat,
      origLon: isArrival ? farCoord?.lon ?? null : self.lon,
      destIata: isArrival ? self.iata : farIata,
      destLat: isArrival ? self.lat : farCoord?.lat ?? null,
      destLon: isArrival ? self.lon : farCoord?.lon ?? null,
      schedArrEpoch: epoch(arrivalTime?.utc),
    });
  }
}

const API_HOST = 'aerodatabox.p.rapidapi.com';

/**
 * Fetch one board's arrivals + departures. Throws on transport failure --
 * the caller (index.ts's `scheduled`) treats one board failing as
 * non-fatal and keeps the rows the other boards already produced.
 *
 * Host and header confirmed live against this endpoint: `x-rapidapi-key`
 * alone is sufficient (tested by omitting `x-rapidapi-host` and getting a
 * normal 200), but `x-rapidapi-host` is included anyway per RapidAPI's
 * documented convention for routing a key that may be subscribed to more
 * than one API -- cheap to send, and it is what the plan's own sketch names
 * as the surface this key is for.
 *
 * The 12-hour window (2h back, 10h forward) matters: flights already
 * airborne departed in the past, so a forward-only window misses exactly the
 * aircraft overhead right now.
 */
export async function fetchBoard(icao: string, apiKey: string): Promise<ScheduleRow[]> {
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 3600_000).toISOString().slice(0, 16);
  const to = new Date(now.getTime() + 10 * 3600_000).toISOString().slice(0, 16);
  const url =
    `https://${API_HOST}/flights/airports/icao/${icao}/${from}/${to}` +
    `?withLeg=true&direction=Both&withCancelled=false&withCodeshared=false`;
  const res = await fetch(url, {
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': API_HOST },
  });
  if (!res.ok) throw new Error(`aerodatabox ${icao} ${res.status}`);
  return parseFids(await res.json(), icao);
}
