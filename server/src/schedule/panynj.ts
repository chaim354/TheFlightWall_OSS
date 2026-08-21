import { compressToEncodedURIComponent } from 'lz-string';
import { getAirportCoordByIata } from './airports';
import type { ScheduleRow } from '../types';

/**
 * Port Authority of New York and New Jersey flight boards -- a second,
 * free schedule source alongside src/schedule/aerodatabox.ts.
 *
 * WHY THIS EXISTS. AeroDataBox is billable, so we refresh it only every 6
 * hours over a +/-6h window. That window is centred on BUILD time, not on
 * "now", so by the end of each cycle the forward half is spent: at build+6h
 * the aircraft overhead are landing at build+6h and later, and the table
 * stops exactly at build+6h. Route fill therefore decays across every
 * cycle. It also misses rows AeroDataBox populates late -- measured live,
 * DL2532 (PBI->LGA, landing 13:50Z) was absent from a table built at
 * 13:43Z and present in the same board 15 minutes later. This source is
 * free, so it can be polled every few minutes and the window kept centred
 * on now, which is the actual fix for both.
 *
 * WHAT IT COVERS. JFK, LGA and EWR -- the three airports the Port Authority
 * operates. BOS is Massport's and is NOT available here; it stays on
 * AeroDataBox. See refresh.ts for how the two sources combine.
 *
 * THE TRANSPORT IS UNUSUAL, and every part of it was confirmed against the
 * live endpoint rather than guessed:
 *
 *   - `POST /api/graphql` with `content-type: text/plain`, NOT
 *     application/json. A normal JSON POST is rejected with a 400 and an
 *     HTML error page.
 *   - The body is the JSON request payload run through lz-string's
 *     `compressToEncodedURIComponent` (their client is Apollo with an
 *     lz-string link).
 *   - The server matches the query TEXT against an allowlist. Sending a
 *     query that differs only in WHITESPACE -- verified: reformatting
 *     `paging { next __typename }` onto one line -- is rejected with the
 *     same 400. So QUERY_DEPARTURES/QUERY_ARRIVALS below must stay
 *     byte-for-byte identical to what their site sends. They were captured
 *     from the live page, are stored verbatim in
 *     fixtures/panynj-queries.json, and test/panynj.test.ts asserts the two
 *     still match. If the Port Authority redeploys with a reformatted
 *     query, that test fails loudly instead of the fetch silently 400ing
 *     in production.
 *   - No cookies, session, or browser context are needed: verified working
 *     from a plain Node process.
 *
 * RATE LIMITING IS REAL. A burst of ~12-15 unspaced requests earned a 403
 * on every subsequent call, including ones that had just succeeded; it
 * cleared on its own within a few minutes. At `PAGE_DELAY_MS` spacing an
 * 18-request run (3 rounds of 6 boards, 60s apart) came back 18/18 clean.
 * A full refresh is ~8 requests, so a 10-minute cadence sits an order of
 * magnitude under what was measured safe. Do not remove the pacing.
 *
 * Never throws from parsing: a malformed payload, row, or field degrades to
 * skipping that row, exactly as aerodatabox.ts and adsblol.ts do. `fetchBoard`
 * DOES throw on transport failure, so refresh.ts can fall back to AeroDataBox
 * for that airport.
 */

const ENDPOINT = 'https://www.jfkairport.com/api/graphql';

/**
 * All three boards are served by this one host -- verified by fetching LGA
 * and EWR data from it. There are separate laguardiaairport.com and
 * newarkairport.com hosts, but they front the same backend, and using one
 * origin keeps the pacing below a single, easily-reasoned-about budget
 * rather than three independent ones.
 */
const AIRPORTS = ['JFK', 'LGA', 'EWR'] as const;
export type PanynjAirport = (typeof AIRPORTS)[number];

export function isPanynjAirport(iata: string): iata is PanynjAirport {
  return (AIRPORTS as readonly string[]).includes(iata.toUpperCase());
}

/** Every Port Authority airport is in this zone, so one constant covers all three. */
const TZ = 'America/New_York';

/**
 * Page size. The UI asks for 15; 500 works and is the largest value
 * confirmed good. Above it the endpoint answered 403 -- but so did a
 * repeat of a previously-successful 500 immediately afterwards, so that
 * 403 was the rate limiter, not a page-size ceiling. 500 is used because
 * it is measured-safe, not because a larger page is known to be refused.
 */
const PAGE_LIMIT = 500;

/** Spacing between requests. See the rate-limiting note in the file header. */
export const PAGE_DELAY_MS = 2000;

/**
 * Pages per board per direction. At a +/-3h window, LGA and EWR return
 * everything in one page (336/327/314/439 rows measured) and JFK needs two
 * -- JFK's board is inflated 3-4x by codeshares, one physical flight being
 * listed once per marketing carrier (a single JFK->ORD departure appeared
 * 15 times, under VS/DL/SK/LA/KQ and others). 4 is a backstop against an
 * unbounded loop if `paging.next` ever stops terminating, not a target.
 */
const MAX_PAGES = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- the allowlisted query text -- see the header. Do not reformat. -------

const QUERY_DEPARTURES = `query GetDepartingFlights($departureAirport: String!, $departureDateTime: String!, $destinationAirport: String, $carrierCode: String, $limit: Int, $after: String) {
  getDepartingFlights(
    departureAirport: $departureAirport
    departureDateTime: $departureDateTime
    destinationAirport: $destinationAirport
    carrierCode: $carrierCode
    limit: $limit
    after: $after
  ) {
    data {
      dateScheduled
      timeScheduled
      dateRevised
      timeRevised
      destinationName
      destinationAirportCode
      airlineCode
      airlineName
      flightNumber
      terminal
      gate
      status
      __typename
    }
    paging {
      next
      __typename
    }
    __typename
  }
}`;

const QUERY_ARRIVALS = `query GetArrivingFlights($arrivalAirport: String!, $arrivalDateTime: String!, $originAirport: String, $carrierCode: String, $limit: Int, $after: String) {
  getArrivingFlights(
    arrivalAirport: $arrivalAirport
    arrivalDateTime: $arrivalDateTime
    originAirport: $originAirport
    carrierCode: $carrierCode
    limit: $limit
    after: $after
  ) {
    data {
      dateScheduled
      timeScheduled
      dateRevised
      timeRevised
      originName
      originAirportCode
      airlineCode
      airlineName
      flightNumber
      terminal
      gate
      status
      isInternationalFlight
      __typename
    }
    paging {
      next
      __typename
    }
    __typename
  }
}`;

/** Exposed for the fixture-equality test, not for callers. */
export const QUERIES = { departures: QUERY_DEPARTURES, arrivals: QUERY_ARRIVALS } as const;

// --- time -----------------------------------------------------------------

/**
 * How far ahead of UTC `America/New_York` is at a given instant, in ms.
 *
 * Uses Intl rather than a hardcoded -4/-5 because the offset depends on DST,
 * and a wrong hour here would put every ETA an hour out for half the year.
 * Node 22 ships full ICU, so the zone is always available.
 */
function tzOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p: Record<string, number> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = Number(part.value);
  // hour can format as 24 for midnight under hour12:false; normalise to 0.
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return asUtc - utcMs;
}

/**
 * A local New York wall-clock time -> UTC epoch seconds.
 *
 * Two passes, deliberately. The offset must be sampled at the true instant,
 * but the true instant is what we are solving for, so the first pass samples
 * at the naive instant and the second corrects it. Without that second pass
 * every time within an hour of a DST boundary lands an hour out.
 */
function nyWallToEpoch(y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const firstGuess = naive - tzOffsetMs(naive);
  return Math.floor((naive - tzOffsetMs(firstGuess)) / 1000);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

/** "2026-08-21" + "09:40 AM" -> epoch seconds, or null if either is unusable. */
function parseLocal(dateStr: unknown, timeStr: unknown): number | null {
  if (typeof dateStr !== 'string' || typeof timeStr !== 'string') return null;
  const d = DATE_RE.exec(dateStr.trim());
  const t = TIME_RE.exec(timeStr.trim());
  if (!d || !t) return null;
  let hour = Number(t[1]) % 12;
  if (t[3]!.toUpperCase() === 'PM') hour += 12;
  return nyWallToEpoch(Number(d[1]), Number(d[2]), Number(d[3]), hour, Number(t[2]));
}

const TWELVE_HOURS = 12 * 3600;

/**
 * The revised time, resolved against the scheduled one.
 *
 * `dateRevised` is ALWAYS null in the live payload -- measured 0/500 on a JFK
 * arrivals board and 0/336 on an LGA departures board, while `timeRevised`
 * was present on 482/500 and 180/336 respectively. So the revised time
 * arrives as a bare wall clock with no date, and the date has to be inferred
 * from the scheduled one.
 *
 * Naively pairing it with `dateScheduled` breaks across midnight: a flight
 * scheduled 11:50 PM and revised to 12:20 AM would land 23.5 hours EARLY
 * instead of 30 minutes late. Resolving to whichever adjacent day puts the
 * revised time nearest the scheduled one fixes both directions -- a delay
 * past midnight and an early arrival back before it. A real revision is
 * never close to 12 hours, so the nearest-day choice is unambiguous.
 *
 * `dateRevised` is still honoured when present: it has not been observed,
 * but if the provider starts sending it, it is better information than an
 * inference.
 */
function parseRevised(row: Record<string, unknown>, schedEpoch: number | null): number | null {
  const explicit = parseLocal(row.dateRevised, row.timeRevised);
  if (explicit !== null) return explicit;

  const sameDay = parseLocal(row.dateScheduled, row.timeRevised);
  if (sameDay === null) return null;
  if (schedEpoch === null) return sameDay;

  const drift = sameDay - schedEpoch;
  if (drift < -TWELVE_HOURS) return sameDay + 24 * 3600; // revised rolled past midnight
  if (drift > TWELVE_HOURS) return sameDay - 24 * 3600; // revised rolled back before it
  return sameDay;
}

// --- parsing --------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Flight number as a string, leading zeros stripped, to match
 * `callsignKey`'s normalisation in src/join.ts -- the two are compared for
 * equality, so they must agree on "0032" vs "32".
 *
 * Note what is NOT needed here: the carrier and the number arrive in
 * SEPARATE fields (`airlineCode: "B6"`, `flightNumber: 1184`). The
 * digit-in-carrier-code hazard that corrupted 15% of the AeroDataBox table
 * -- "B6 1184" collapsing to carrier B6, number 61184 -- is structurally
 * impossible here, because there is no combined string to split.
 */
function numberOf(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.trunc(Math.abs(v))) : null;
  const s = str(v);
  if (!/^\d+$/.test(s)) return null;
  return s.replace(/^0+/, '') || '0';
}

export type BoardDirection = 'arrival' | 'departure';

/**
 * Parse one board response into schedule rows.
 *
 * `boardIata` is the airport whose board this is -- the near end, which the
 * payload leaves implicit exactly as AeroDataBox's FIDS does.
 *
 * ON ARRIVAL TIMES, and why departures carry none. `timeScheduled` means
 * "the movement at THIS board": arrival time on an arrivals board, departure
 * time on a departures board. The departures query returns no arrival time
 * for the far end at all -- there is no such field. So a departures row
 * yields a route but leaves `schedArrEpoch`/`revArrEpoch` null, and
 * src/enrich.ts falls through to the physics ETA for it. Inventing an
 * arrival time from a departure time would be exactly the confident-wrong
 * answer this project blanks instead. Arrivals rows, where the time IS the
 * arrival, carry both -- and carry a revised time far more often than
 * AeroDataBox does (96% vs 39% measured), which is the case that matters
 * most on the panel: an aircraft overhead about to land.
 *
 * `callsign` is always null: these boards publish the marketing carrier and
 * number only, never the operating callsign, so the exact-callsign match
 * path in src/join.ts is not available for these rows. AeroDataBox supplies
 * callsigns for ~44% of its rows, which is one reason refresh.ts keeps both
 * sources rather than replacing one with the other.
 */
export function parseBoard(
  body: unknown,
  boardIata: string,
  dir: BoardDirection,
): ScheduleRow[] {
  const data = (body as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data || typeof data !== 'object') return [];
  const field = dir === 'arrival' ? 'getArrivingFlights' : 'getDepartingFlights';
  const payload = data[field] as { data?: unknown } | undefined;
  const list = payload?.data;
  if (!Array.isArray(list)) return [];

  const self = getAirportCoordByIata(boardIata);
  if (!self) return []; // a board we have no coordinates for cannot be corridor-checked

  const isArrival = dir === 'arrival';
  const out: ScheduleRow[] = [];

  for (const raw of list as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;

    // Cancelled flights are not flying, so they can only add same-number
    // collisions for an aircraft that is. AeroDataBox is fetched with
    // withCancelled=false for the same reason.
    if (str(raw.status).toLowerCase() === 'cancelled') continue;

    const number = numberOf(raw.flightNumber);
    if (!number) continue;
    const carrier = str(raw.airlineCode).toUpperCase();
    if (!carrier) continue;

    const farIata = str(isArrival ? raw.originAirportCode : raw.destinationAirportCode).toUpperCase();
    const farCoord = farIata ? getAirportCoordByIata(farIata) : undefined;

    const schedArrEpoch = isArrival ? parseLocal(raw.dateScheduled, raw.timeScheduled) : null;
    const revArrEpoch = isArrival ? parseRevised(raw, schedArrEpoch) : null;

    out.push({
      callsign: null,
      carrierIata: carrier,
      number,
      origIata: isArrival ? farIata || null : self.iata,
      origLat: isArrival ? farCoord?.lat ?? null : self.lat,
      origLon: isArrival ? farCoord?.lon ?? null : self.lon,
      destIata: isArrival ? self.iata : farIata || null,
      destLat: isArrival ? self.lat : farCoord?.lat ?? null,
      destLon: isArrival ? self.lon : farCoord?.lon ?? null,
      schedArrEpoch,
      revArrEpoch,
    });
  }

  return out;
}

// --- fetching -------------------------------------------------------------

/** Local wall-clock stamp in the `YYYY-MM-DDTHH:mm` form the API's range takes. */
function nyStamp(utcMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  const hh = p.hour === '24' ? '00' : p.hour!;
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}`;
}

function packBody(dir: BoardDirection, iata: string, range: string, after: string): string {
  const variables =
    dir === 'arrival'
      ? { arrivalAirport: iata, arrivalDateTime: range, originAirport: '', carrierCode: '', limit: PAGE_LIMIT, after }
      : { departureAirport: iata, departureDateTime: range, destinationAirport: '', carrierCode: '', limit: PAGE_LIMIT, after };
  return compressToEncodedURIComponent(
    JSON.stringify({
      operationName: dir === 'arrival' ? 'GetArrivingFlights' : 'GetDepartingFlights',
      variables,
      // Sent by their client; included because the query text is matched
      // against an allowlist and this payload is what was captured working.
      extensions: { clientLibrary: { name: '@apollo/client', version: '4.0.4' } },
      query: dir === 'arrival' ? QUERY_ARRIVALS : QUERY_DEPARTURES,
    }),
  );
}

export interface FetchBoardOptions {
  /** Half-width of the time window, in hours. */
  windowHours?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so they need not wait out real pacing. */
  pageDelayMs?: number;
}

/**
 * Fetch one airport's board in one direction, following pagination.
 *
 * Throws on transport failure (non-200, unparseable body) so the caller can
 * fall back to another source for this airport. A page that fails partway
 * through throws too rather than returning a silently truncated board: a
 * half-board looks exactly like a complete one to everything downstream,
 * and a missing row is indistinguishable from a flight that is not flying.
 */
export async function fetchBoard(
  iata: string,
  dir: BoardDirection,
  nowMs: number,
  opts: FetchBoardOptions = {},
): Promise<ScheduleRow[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const delayMs = opts.pageDelayMs ?? PAGE_DELAY_MS;
  const halfWidthMs = (opts.windowHours ?? 3) * 3600_000;
  const range = `${nyStamp(nowMs - halfWidthMs)}/${nyStamp(nowMs + halfWidthMs)}`;

  const rows: ScheduleRow[] = [];
  let after = '';

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0 && delayMs > 0) await sleep(delayMs);

    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        accept: 'application/graphql-response+json,application/json;q=0.9',
      },
      body: packBody(dir, iata.toUpperCase(), range, after),
    });
    if (!res.ok) throw new Error(`panynj ${iata} ${dir} ${res.status}`);

    const body = (await res.json()) as {
      errors?: unknown;
      data?: Record<string, { paging?: { next?: unknown } }>;
    };
    if (body?.errors) throw new Error(`panynj ${iata} ${dir} graphql error`);

    rows.push(...parseBoard(body, iata, dir));

    const field = dir === 'arrival' ? 'getArrivingFlights' : 'getDepartingFlights';
    const next = body?.data?.[field]?.paging?.next;
    if (typeof next !== 'string' || !next) return rows;
    after = next;
  }

  // Hit MAX_PAGES with more still on offer. Say so -- a silently capped
  // board reads downstream as a complete one.
  console.warn(`panynj ${iata} ${dir}: stopped at ${MAX_PAGES} pages, more rows were available`);
  return rows;
}
