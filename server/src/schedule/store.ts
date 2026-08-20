import type { ScheduleRow } from '../types';

export const KV_KEY = 'schedule:v1';

/**
 * How old the table may be before responses are flagged stale.
 *
 * Longer than the 6h cron interval, deliberately: one missed refresh should not
 * flag every response. Route data is stable day-to-day (measured 94-100%), so a
 * table a few hours old is still correct — it is a table days old that isn't.
 */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

/**
 * Two indexes over the same rows.
 *
 * `byNumber` is the one that always works: the flight number is the only key
 * both sides share, because ADS-B carries the operator and a schedule row
 * carries the marketing carrier.
 *
 * `byCallsign` is populated only when the provider ships an operating callsign.
 * When it is, it is strictly better — an exact match needs no disambiguation,
 * and it is the only way to join the ~7% of airline callsigns that end in
 * letters (BAW2LJ for BA1228) and so have no derivable number at all.
 */
export interface ScheduleIndex {
  byNumber: Record<string, ScheduleRow[]>;
  byCallsign: Record<string, ScheduleRow[]>;
}

export interface StoredSchedule {
  builtAtMs: number;
  index: ScheduleIndex;
}

export function indexRows(rows: readonly ScheduleRow[]): ScheduleIndex {
  const idx: ScheduleIndex = { byNumber: {}, byCallsign: {} };
  for (const r of rows) {
    (idx.byNumber[r.number] ??= []).push(r);
    if (r.callsign) (idx.byCallsign[r.callsign.trim().toUpperCase()] ??= []).push(r);
  }
  return idx;
}

export function lookupRows(idx: ScheduleIndex, number: string): ScheduleRow[] {
  return idx.byNumber[number] ?? [];
}

export function lookupByCallsign(idx: ScheduleIndex, callsign: string): ScheduleRow[] {
  return idx.byCallsign[callsign.trim().toUpperCase()] ?? [];
}

export async function saveSchedule(kv: KVNamespace, rows: readonly ScheduleRow[], nowMs: number): Promise<void> {
  const payload: StoredSchedule = { builtAtMs: nowMs, index: indexRows(rows) };
  await kv.put(KV_KEY, JSON.stringify(payload));
}

export async function loadSchedule(kv: KVNamespace): Promise<StoredSchedule | null> {
  return await kv.get<StoredSchedule>(KV_KEY, 'json');
}

export function isStale(s: StoredSchedule | null, nowMs: number): boolean {
  return s === null || nowMs - s.builtAtMs > STALE_AFTER_MS;
}
