import { getAirportCoord } from './airports';
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
 * in the fixture, so `getAirportCoord` supplies it, exactly as the plan says.
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
 * `revArrEpoch` (from `row.arrival.revisedTime.utc`) is captured the same
 * way, for the same reason: "the leg's arrival" and "the leg's revised
 * arrival" are both properties of the `arrival` sub-object regardless of
 * which top-level array carried the row. VERIFIED, not assumed -- a
 * departures-array row in the fixture (JU 501, JFK->Belgrade) carries its
 * `arrival` sub-object WITH an `airport` key (Belgrade, the far end, exactly
 * as the direction rule above predicts) and both a `scheduledTime` and a
 * `revisedTime` on that same far-end arrival -- i.e. "when this flight
 * lands," not "when it left JFK." See the direction tests in
 * test/fids.test.ts, which assert this for both directions synthetically.
 *
 * Also verified: whether a revised time can appear without a scheduled one.
 * It does not, anywhere in the 261-row fixture (102 rows carry both; 0 carry
 * revisedTime alone) -- but this code does not lean on that as a guarantee.
 * `revArrEpoch` is parsed independently of `schedArrEpoch`'s presence, so a
 * future payload where the two diverge still degrades correctly rather than
 * silently dropping a revised time because a scheduled one was missing.
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

/**
 * Split a FIDS `number` field ("B6 1184", "DL 4984") into carrier and flight
 * number.
 *
 * The space is the ONLY reliable boundary between the two. Many IATA carrier
 * codes end in a digit -- B6 (JetBlue), F9 (Frontier), G4 (Allegiant), Y4
 * (Volaris), and the single-letter-plus-digit codes N0/D0/B0/H4/S4 -- so
 * collapsing the space before hunting for a flight number, which is what
 * this code used to do, makes a blind trailing-digit-run match ambiguous:
 * "B61184" (what "B6 1184" becomes once the space is gone) reads as carrier
 * "B" number "61184" exactly as validly as carrier "B6" number "1184", and
 * once the space is gone there is no signal left telling you which reading
 * is right. Measured on the live stored table: 374 of 2,436 rows (15%) have
 * a carrier ending in a digit, and every one of them was corrupted this way
 * -- JetBlue (B6) alone accounts for 334 of the 374, e.g. "B6 1184" stored
 * as carrier B6, number 61184 instead of 1184.
 *
 * Parse the space FIRST, before any digit-run matching, so the boundary
 * survives instead of being destroyed. Verified against the full
 * fids-kjfk.json fixture (261 rows, arrivals and departures both): every
 * single row's `number` is a string containing exactly one ASCII space --
 * carrier before it, digits after, no leading zeros seen but handled
 * anyway. So the space-based branch below is the primary path and alone
 * covers 100% of the captured fixture; nothing in it depends on the
 * whitespace-free fallback beneath it.
 *
 * That fallback (no whitespace at all) exists only for a shape this fixture
 * never shows. It has the same ambiguity for a digit-ending carrier that the
 * bug above did -- there is no boundary left to recover one from -- but
 * unlike the bug, that is a property of input that supplies no separator,
 * not a mistake in this code: with nothing marking the boundary, no parse
 * can do better. Kept only so a genuinely unexpected shape degrades to best
 * effort rather than the row being dropped outright, matching this file's
 * never-throw, degrade-don't-drop discipline.
 */
function splitCarrierNumber(raw: string): { carrier: string; number: string } | null {
  if (!raw) return null;

  const spaced = /^(\S+)\s+(\d+)$/.exec(raw);
  if (spaced) {
    const [, carrier, digits] = spaced;
    return { carrier: carrier!, number: digits!.replace(/^0+/, '') || '0' };
  }

  // No whitespace boundary to lean on. Same residual ambiguity as the bug
  // this function fixes, for the reason explained above -- not reachable by
  // anything in the captured fixture.
  const digits = /(\d+)$/.exec(raw)?.[1];
  if (!digits) return null;
  const carrier = raw.slice(0, raw.length - digits.length);
  if (!carrier) return null;
  return { carrier, number: digits.replace(/^0+/, '') || '0' };
}

function collect(
  list: unknown,
  airportIcao: string,
  dir: 'arrival' | 'departure',
  out: ScheduleRow[],
): void {
  if (!Array.isArray(list)) return;
  const self = getAirportCoord(airportIcao);
  if (!self) return; // a board we have no coordinates for cannot be checked

  const isArrival = dir === 'arrival';

  for (const m of list as Record<string, unknown>[]) {
    const parsed = splitCarrierNumber(str(m?.number));
    if (!parsed) continue; // no derivable flight number -- cannot index this row

    const airline = m?.airline as Record<string, unknown> | undefined;
    const carrier = str(airline?.iata) || parsed.carrier;
    if (!carrier) continue;

    // The far end is whichever side ("departure" for an arrivals-array row,
    // "arrival" for a departures-array row) carries the `airport` object.
    const far = (isArrival ? m?.departure : m?.arrival) as Record<string, unknown> | undefined;
    const farAirport = far?.airport as Record<string, unknown> | undefined;
    const farIcao = str(farAirport?.icao).toUpperCase() || null;
    const farIata = str(farAirport?.iata) || null;
    // FIDS carries no coordinates for either end (verified: neither `lat`,
    // `lon`, nor `location` appears anywhere in the captured fixture). The
    // far end's coordinates come from a bundled table generated from
    // OurAirports -- see airports.ts for provenance and coverage.
    const farCoord = farIcao ? getAirportCoord(farIcao) : undefined;

    // The row's own `arrival` sub-object is always the scheduled arrival --
    // at this board for an arrivals-array row, at the far end for a
    // departures-array row -- so no direction branch is needed here. Same
    // for the revised time: it lives on the same sub-object, one key over.
    const arrivalSide = m?.arrival as Record<string, unknown> | undefined;
    const arrivalScheduled = arrivalSide?.scheduledTime as Record<string, unknown> | undefined;
    const arrivalRevised = arrivalSide?.revisedTime as Record<string, unknown> | undefined;

    out.push({
      callsign: str(m?.callSign) || null,
      carrierIata: carrier.toUpperCase(),
      number: parsed.number,
      origIata: isArrival ? farIata : self.iata,
      origLat: isArrival ? farCoord?.lat ?? null : self.lat,
      origLon: isArrival ? farCoord?.lon ?? null : self.lon,
      destIata: isArrival ? self.iata : farIata,
      destLat: isArrival ? self.lat : farCoord?.lat ?? null,
      destLon: isArrival ? self.lon : farCoord?.lon ?? null,
      schedArrEpoch: epoch(arrivalScheduled?.utc),
      revArrEpoch: epoch(arrivalRevised?.utc),
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
 * The window matters and is centred, not forward-biased -- see the comment on
 * the computation below for the measurement that settled it.
 */
export interface FetchBoardOptions {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export async function fetchBoard(
  icao: string,
  apiKey: string,
  opts: FetchBoardOptions = {},
): Promise<ScheduleRow[]> {
  // PRECONDITION, checked before any I/O. collect() silently returns when it
  // has no coordinates for the board, so a typo'd or newly-added BOARDS entry
  // used to make a real billable call (2 units) every pass, forever, yield an
  // empty board, and report nothing -- roughly 720 wasted units/month per bad
  // board against a 6,000-unit budget. It is a config error knowable without
  // asking the network, so ask nothing.
  if (!getAirportCoord(icao)) {
    throw new Error(`aerodatabox ${icao}: no coordinates for this board (check BOARDS)`);
  }

  // Window is centred, not forward-biased. FIDS rows are keyed on SCHEDULED
  // time, but we match aircraft that are airborne NOW -- and a delayed flight
  // still in the air can have been scheduled many hours ago. A -2h/+10h window
  // missed every one of them.
  //
  // Measured against 8 aircraft actually overhead JFK, matching on the KJFK
  // board alone:
  //   -2h/+10h  436 rows  0/8 matched   <- what this used to be
  //   -6h/+6h   508 rows  3/8 matched
  //   -9h/+3h   538 rows  3/8 matched   <- more rows, no better
  // -9h buys nothing over -6h and starves the forward half, which is what
  // catches flights about to depart. 12h total is AeroDataBox's cap.
  const now = new Date();
  const from = new Date(now.getTime() - 6 * 3600_000).toISOString().slice(0, 16);
  const to = new Date(now.getTime() + 6 * 3600_000).toISOString().slice(0, 16);
  const url =
    `https://${API_HOST}/flights/airports/icao/${icao}/${from}/${to}` +
    `?withLeg=true&direction=Both&withCancelled=false&withCodeshared=false`;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': API_HOST },
  });
  if (!res.ok) throw new Error(`aerodatabox ${icao} ${res.status}`);

  const body = await res.json();

  // POSTCONDITION. parseFids never throws by design -- one bad row must not
  // cost the board -- which means a payload whose SHAPE changed degrades to
  // "this board has no flights", indistinguishable from a quiet board. Draw
  // the line here instead, where the difference is still visible: neither list
  // present at all is a transport-level failure, not an empty board. The
  // sibling adapter already enforces exactly this (panynj.ts's `if
  // (body?.errors) throw`), and a 204 on this path already throws out of
  // res.json(), so "empty-looking board throws, previous table kept" is
  // established behaviour here rather than something new.
  //
  // Defence in depth BEHIND refresh.ts's write gate, which is the
  // authoritative fix for an empty table from any cause. What this adds is
  // naming WHICH board went wrong, which a row count alone cannot.
  const b = body as { arrivals?: unknown; departures?: unknown };
  if (!Array.isArray(b?.arrivals) && !Array.isArray(b?.departures)) {
    throw new Error(`aerodatabox ${icao}: payload carried neither arrivals nor departures`);
  }

  return parseFids(body, icao);
}
