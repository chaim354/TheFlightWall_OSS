import { fetchBoard } from './aerodatabox';
import { saveSchedule, type ScheduleStorage } from './store';
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
 * limit), then write the combined rows -- unless every board failed, in
 * which case the previous table is left in place rather than overwritten
 * with an empty one. An empty table would blank every route until the next
 * refresh; the existing table aging into `stale` is the honest outcome.
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

  for (let i = 0; i < boards.length; i++) {
    const icao = boards[i]!;
    try {
      rows.push(...(await fetchBoard(icao, apiKey)));
      ok++;
    } catch (e) {
      // One board failing must not cost us the other three.
      console.error(`board ${icao} failed:`, e instanceof Error ? e.message : String(e));
    }
    if (i < boards.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  if (ok === 0) {
    // Writing an empty table would blank every route until the next refresh.
    // Leave the previous one in place and let it age into `stale` honestly.
    console.error('all boards failed; keeping the previous table');
    return;
  }

  await saveSchedule(storage, rows, nowMs);
  console.log(`schedule: ${rows.length} rows from ${ok}/${boards.length} boards`);
}
