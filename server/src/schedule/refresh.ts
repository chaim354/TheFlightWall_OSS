import { fetchBoard } from './aerodatabox';
import { fetchBoard as fetchPanynj, PAGE_DELAY_MS } from './panynj';
import { allRows, loadSchedule, saveSchedule, type ScheduleStorage } from './store';
import type { ScheduleRow } from '../types';

/**
 * Delay between board fetches within one refresh pass.
 *
 * Observed live against AeroDataBox's free plan: a same-key burst of 4
 * board requests with no spacing got 429'd on 3 of 4 (KJFK succeeded with
 * 458 rows; KLGA/KEWR/KBOS all failed). This is a per-key rate limit, not
 * an egress-IP issue -- unlike the adsb.lol problem this port exists to
 * fix -- so it reproduces identically however the request is dispatched.
 * Both entry points call this same paced routine for that reason.
 */
export const BOARD_FETCH_DELAY_MS = 1500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Refresh the schedule table from every configured board: fetch each in
 * turn (paced by `delayMs` so a burst doesn't trip AeroDataBox's rate
 * limit), collapse the rows to one per flight leg, then write them -- unless
 * that leaves nothing, in which case the previous table is left in place
 * rather than overwritten with an empty one. An empty table would blank every
 * route until the next refresh; the existing table aging into `stale` is the
 * honest outcome.
 *
 * Note the guard is on ROWS PRODUCED, not on boards that answered. A board can
 * return 200 and yield nothing -- see the comment at the write below.
 *
 * Never throws: a single board failing is logged and skipped, same
 * discipline as every other fetch in this codebase (adsblol.ts,
 * aerodatabox.ts) -- one bad board must not cost the others.
 */
export async function refreshSchedule(
  boards: readonly string[],
  apiKey: string,
  storage: ScheduleStorage,
  nowMs: number,
  delayMs: number = BOARD_FETCH_DELAY_MS,
): Promise<void> {
  const rows: ScheduleRow[] = [];
  let ok = 0;
  // Boards that answered without throwing and still yielded nothing. Tracked
  // separately from `ok` because the two are NOT the same outcome, and
  // conflating them is what let a partially-empty table read as healthy.
  const barren: string[] = [];

  for (let i = 0; i < boards.length; i++) {
    const icao = boards[i]!;
    try {
      // Tagged at this layer rather than in aerodatabox.ts's parser so the
      // parser stays a pure payload->row mapping (and its tests keep asserting
      // exact row shapes).
      const before = rows.length;
      for (const r of await fetchBoard(icao, apiKey)) rows.push({ ...r, src: 'adb' });
      ok++;
      if (rows.length === before) barren.push(icao);
    } catch (e) {
      // One board failing must not cost us the other three.
      console.error(`board ${icao} failed:`, e instanceof Error ? e.message : String(e));
    }
    if (i < boards.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  // ONE ROW PER LEG. Every board is fetched `direction=Both`, so a JFK->BOS
  // leg arrives twice -- once from the KJFK board as a departure, once from
  // the KBOS board as an arrival -- and the two rows are field-for-field
  // identical, because airports.ts is one unified table and the `arrival`
  // sub-object is the scheduled arrival in both directions. Left concatenated,
  // the pair scores an identical corridor excess and matchSchedule's tiebreak
  // refuses both, blanking the route for exactly the inter-board shuttle
  // traffic overhead. Same key, same merge as the Port Authority path below.
  const merged = mergeByFlight(rows, []);

  // GATE ON ROWS PRODUCED, NOT ON FETCHES THAT DID NOT THROW. `ok` counts the
  // latter, so `ok > 0` with zero rows used to write an EMPTY table stamped
  // with a fresh builtAtMs -- and isStale() reads builtAtMs alone, so it
  // reported stale:false with no routes and rewrote itself identically every
  // tick. parseFids returns [] on a payload-shape change, and collect() bails
  // silently on a non-array or an unknown board ICAO, so this is reachable
  // without a single failed request. Testing the MERGED array is deliberate:
  // it is the thing actually about to be written.
  // PARTIAL COVERAGE MUST NOT PASS SILENTLY. A board that answers 200 and
  // yields nothing is a defect every time: a 12h FIDS window at any of these
  // airports is never legitimately empty, so this means a payload-shape change
  // parseFids returned [] for, a board ICAO getAirportCoord does not know (
  // collect() bails on it), or a board throttled into an empty body. With the
  // other boards still contributing, neither guard below fires and the table
  // is written a quarter short with a fresh builtAtMs -- healthy-looking and
  // self-sustaining. It is still better to store what we got than to discard
  // it, so this reports rather than blocks; deciding whether a coverage floor
  // should also block the write needs production data on how often this fires.
  if (barren.length > 0) {
    console.error(
      `boards answered with no rows: ${barren.join(', ')}` +
        (merged.length === 0 ? '' : ' -- writing partial coverage'),
    );
  }

  if (merged.length === 0) {
    // Leave the previous table in place and let it age into `stale` honestly.
    // Strictly more conservative than writing: a genuinely empty window costs
    // freshness, where an empty write costs every route.
    console.error(`no rows from ${ok}/${boards.length} boards; keeping the previous table`);
    return;
  }

  await saveSchedule(storage, merged, nowMs);
  console.log(
    `schedule: ${merged.length} rows from ${ok - barren.length}/${boards.length} boards` +
      (merged.length === rows.length ? '' : ` (${rows.length - merged.length} cross-board duplicates collapsed)`),
  );
}

/**
 * Refresh from the Port Authority boards and MERGE the result into whatever
 * the AeroDataBox pass last stored, rather than replacing it.
 *
 * The two sources are complementary, not redundant:
 *
 *   - Port Authority is free and live, so it can run every few minutes with
 *     its window centred on now. That is what fixes the decay described in
 *     panynj.ts's header. It also carries a revised arrival time on ~96% of
 *     arrivals against AeroDataBox's ~39%.
 *   - AeroDataBox covers BOS, which the Port Authority does not operate at
 *     all; supplies an operating callsign on ~44% of its rows (the
 *     exact-match path in join.ts, the most reliable match there is, and one
 *     these boards cannot feed because they publish only the marketing
 *     carrier and number); and carries a far-end arrival time for DEPARTURES,
 *     which the Port Authority departures board has no field for at all.
 *
 * WHY THE MERGE IS BY KEY AND NOT A UNION. Simply concatenating both sources
 * would be actively harmful, not merely wasteful. Two rows describing the
 * SAME flight have the same origin and destination, so they score an
 * identical corridor `excess` in matchSchedule -- and its tiebreak returns
 * null unless one candidate beats the next by TIEBREAK_MARGIN_KM. A union
 * would therefore BLANK the route for exactly the flights both sources list.
 * (Not universally: a row carrying an operating callsign is returned by the
 * exact-match path before the tiebreak is reached. But a Port Authority row
 * never carries one and 56% of AeroDataBox rows do not either, so most
 * flights fall through to the path that blanks. Both halves of that are
 * asserted in test/refreshPanynj.test.ts.) Rows are keyed on
 * carrier+number+route and merged field-wise instead: the fresher Port
 * Authority row wins, and anything it leaves null -- its callsign always, its
 * arrival times on departures rows -- is filled from the AeroDataBox row it
 * superseded.
 *
 * Never throws, and never writes a table it could not populate: if every
 * board fails the previous table is left in place to age honestly.
 */
export async function refreshPanynj(
  storage: ScheduleStorage,
  nowMs: number,
  delayMs: number = PAGE_DELAY_MS,
): Promise<void> {
  if (nowMs < blockedUntilMs) {
    console.log(`panynj: backing off, ${Math.round((blockedUntilMs - nowMs) / 1000)}s remaining`);
    return;
  }

  const fresh: ScheduleRow[] = [];
  let ok = 0;
  let attempted = 0;
  let forbidden = false;

  for (const iata of PANYNJ_AIRPORTS) {
    for (const dir of ['arrival', 'departure'] as const) {
      // Once we know we are blocked, the remaining boards in this pass will
      // be blocked too, and hammering a rate limiter is what deepens it.
      if (forbidden) break;
      if (attempted > 0 && delayMs > 0) await sleep(delayMs);
      attempted++;
      try {
        const rows = await fetchPanynj(iata, dir, nowMs, { pageDelayMs: delayMs });
        for (const r of rows) fresh.push({ ...r, src: 'pa' });
        ok++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // One board-direction failing must not cost the other five -- unless
        // it is a 403, which is this endpoint's rate-limit response and
        // applies to the whole origin, not to one board.
        if (/\b403\b/.test(msg)) forbidden = true;
        console.error(`panynj ${iata} ${dir} failed:`, msg);
      }
    }
  }

  if (forbidden) noteBlocked(nowMs);
  else if (ok > 0) clearBlocked();

  if (ok === 0) {
    console.error('all panynj boards failed; keeping the previous table');
    return;
  }

  // Same rule as refreshSchedule: a pass that produced no rows must not
  // re-stamp builtAtMs. Without this, boards that answer 200 with an empty
  // body refresh the table's apparent age while adding nothing to it.
  if (fresh.length === 0) {
    console.error(`panynj: no rows from ${ok}/${attempted} boards; keeping the previous table`);
    return;
  }

  const prior = await storedRows(storage);
  const kept = prior.rows.filter((r) => r.src !== 'pa');

  // The table is only as fresh as its OLDEST surviving layer. `kept` is the
  // AeroDataBox layer, which this pass did not re-fetch, so stamping it with now
  // would claim a freshness it does not have -- and isStale is a pure comparison
  // over this one number, so a Port Authority pass succeeding on its shorter
  // cadence while refreshSchedule failed every time would have kept the table
  // reporting itself fresh forever, however old the AeroDataBox rows got.
  //
  // Guarded on something actually having been kept: a first-ever write onto an
  // empty store must stamp now, or it is born stale.
  const builtAtMs = kept.length && prior.builtAtMs !== null ? Math.min(prior.builtAtMs, nowMs) : nowMs;

  const merged = mergeByFlight(fresh, kept);
  await saveSchedule(storage, merged, builtAtMs);
  console.log(
    `schedule: ${merged.length} rows (${fresh.length} panynj from ${ok}/${attempted} boards, ${kept.length} kept)`,
  );
}

export const PANYNJ_AIRPORTS = ['JFK', 'LGA', 'EWR'] as const;

/**
 * Backoff after a 403.
 *
 * WHY THIS IS NOT OPTIONAL. The Port Authority endpoint answers 403 when it
 * decides we have asked for too much, and the block is per-origin and
 * time-based, not per-board: while it holds, EVERY request fails, including
 * ones that had been succeeding moments earlier. It was tripped twice while
 * this adapter was being built and cleared on its own both times.
 *
 * AND THE SAFE RATE IS NOT KNOWN. A deliberate probe -- 18 requests at 2s
 * spacing across 5 minutes -- drew no throttling at all, which suggested a
 * 10-minute, 8-request cadence had an order of magnitude of headroom. That
 * conclusion did not survive: a later, much lighter burst was refused, which
 * means there is a longer accounting window than the probe measured and the
 * probe's own traffic counted toward it. So the cadence in server.ts is a
 * guess bounded by this backoff, not a measured-safe figure, and the honest
 * position is that it needs observing in production before being trusted or
 * shortened.
 *
 * Doubling from 15 minutes to a 4-hour ceiling. Long, deliberately: the
 * AeroDataBox table underneath is complete and only hours stale, so backing
 * off a long way costs a little route freshness, while hammering a limiter
 * risks a harder block that costs this source entirely.
 */
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 4 * 60 * 60 * 1000;

let blockedUntilMs = 0;
let backoffMs = 0;

function noteBlocked(nowMs: number): void {
  backoffMs = backoffMs === 0 ? BACKOFF_BASE_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  blockedUntilMs = nowMs + backoffMs;
  console.error(`panynj: 403, backing off ${Math.round(backoffMs / 60000)}m`);
}

function clearBlocked(): void {
  blockedUntilMs = 0;
  backoffMs = 0;
}

/** Test-only: module state would otherwise leak between cases. */
export function resetPanynjBackoff(): void {
  clearBlocked();
}

/**
 * Every row in the stored table.
 *
 * Read back out of `byNumber` because that is where the rows live -- the
 * stored shape is `{builtAtMs, index:{byNumber, byCallsign}}` with no flat
 * array, and `byNumber` is the complete set (indexRows files EVERY row under
 * its number, while `byCallsign` gets only those that have a callsign).
 *
 * Degrades to an empty list rather than throwing: a missing or unreadable
 * table means this pass simply has nothing to merge onto.
 */
async function storedRows(storage: ScheduleStorage): Promise<{ rows: ScheduleRow[]; builtAtMs: number | null }> {
  // Was a hand-rolled shape check here; loadSchedule now owns that for both
  // backends, so a table that parsed but is not usable arrives as null. Returns
  // the stamp as well as the rows -- the merge below needs to know how old what
  // it is keeping actually is.
  const stored = await loadSchedule(storage).catch(() => null);
  if (!stored) return { rows: [], builtAtMs: null };
  return { rows: allRows(stored.index), builtAtMs: stored.builtAtMs };
}

/** Identity of a scheduled leg, for deduplicating across sources. */
const flightKey = (r: ScheduleRow): string =>
  `${r.carrierIata}|${r.number}|${r.origIata ?? ''}|${r.destIata ?? ''}`;

/**
 * Merge `fresh` over `kept`, one row per flight.
 *
 * Field-wise, not row-wise: a fresh row wins on every field it actually has,
 * but a null in it is filled from the row it superseded rather than
 * destroying information the other source had. That is what preserves an
 * AeroDataBox callsign under a Port Authority row, and what keeps the far-end
 * arrival time on a departures row the Port Authority board cannot supply one
 * for.
 */
function mergeByFlight(fresh: readonly ScheduleRow[], kept: readonly ScheduleRow[]): ScheduleRow[] {
  const out = new Map<string, ScheduleRow>();
  for (const r of kept) out.set(flightKey(r), r);
  for (const r of fresh) {
    const key = flightKey(r);
    const prior = out.get(key);
    out.set(key, prior ? fillNulls(r, prior) : r);
  }
  return [...out.values()];
}

/** `primary` with each null field filled from `secondary`. */
function fillNulls(primary: ScheduleRow, secondary: ScheduleRow): ScheduleRow {
  return {
    ...primary,
    callsign: primary.callsign ?? secondary.callsign,
    origLat: primary.origLat ?? secondary.origLat,
    origLon: primary.origLon ?? secondary.origLon,
    destLat: primary.destLat ?? secondary.destLat,
    destLon: primary.destLon ?? secondary.destLon,
    schedArrEpoch: primary.schedArrEpoch ?? secondary.schedArrEpoch,
    revArrEpoch: primary.revArrEpoch ?? secondary.revArrEpoch,
  };
}
