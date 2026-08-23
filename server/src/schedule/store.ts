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

/**
 * Storage abstraction the schedule table is read/written through, so
 * saveSchedule/loadSchedule (and everything upstream of them, including
 * handleFlights) don't care whether the backing store is Workers KV or a
 * file on disk. Two implementations: `kvStorage` below wraps the existing
 * KV binding unchanged (the Worker keeps its exact current behaviour);
 * `fileStorage`, in ./fileStorage.ts, backs the Node/Kamal entry point with
 * a JSON file. That file is kept separate from this one specifically so it
 * can import `node:fs` -- this module must stay free of Node built-ins,
 * because index.ts (the Worker entry) imports it, and Wrangler bundles the
 * Worker straight from this source with no Node-compat shim configured.
 */
export interface ScheduleStorage {
  read(): Promise<StoredSchedule | null>;
  write(s: StoredSchedule): Promise<void>;
}

/** Wraps a Workers KV binding. Same key, same JSON shape as before Task 1 --
 * this is a pure refactor, not a behaviour change, for the Worker path. */
export function kvStorage(kv: KVNamespace): ScheduleStorage {
  return {
    async read(): Promise<StoredSchedule | null> {
      return await kv.get<StoredSchedule>(KV_KEY, 'json');
    },
    async write(s: StoredSchedule): Promise<void> {
      await kv.put(KV_KEY, JSON.stringify(s));
    },
  };
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

/** Every row in the table, flattened back out of the index it was built into. */
export function allRows(idx: ScheduleIndex): ScheduleRow[] {
  return Object.values(idx.byNumber).flat();
}

/**
 * `builtAtMs`, not `nowMs`: it is when the CONTENT was fetched, which equals now
 * only for a full replace. A merge keeps rows the current pass did not re-fetch,
 * and stamping those with now claims a freshness they do not have -- see
 * refresh.ts's merge path, which passes the older of the two.
 */
export async function saveSchedule(storage: ScheduleStorage, rows: readonly ScheduleRow[], builtAtMs: number): Promise<void> {
  const payload: StoredSchedule = { builtAtMs, index: indexRows(rows) };
  await storage.write(payload);
}

/**
 * Does this parsed value actually have the shape consumers dereference?
 *
 * Both backends deserialize with an unchecked cast -- fileStorage's
 * `JSON.parse(raw) as StoredSchedule` and kvStorage's `kv.get<StoredSchedule>`
 * -- so `read()` promises `StoredSchedule | null` while the non-null branch may
 * be any JSON value at all. fileStorage's comment promises corrupt files
 * degrade to null, and that holds for syntactically bad JSON only.
 *
 * The damage from the gap is specific rather than theoretical. Given
 * `{"index":{}}`, isStale computes `nowMs - undefined` = NaN, and
 * `NaN > STALE_AFTER_MS` is FALSE -- so the table reports itself FRESH, forever.
 * handleFlights then dereferences `stored.index.byCallsign` and throws a
 * TypeError well past the `.catch()` attached to the read, which the Node path
 * turns into a 500 on every request and the Worker path does not catch at all.
 *
 * Checks only the three fields consumers actually reach for, deliberately: row
 * contents are not validated here. A row that is individually malformed is
 * already handled downstream, and walking 4,000 of them on every load to prove
 * it would cost more than the bug.
 */
function isStoredSchedule(v: unknown): v is StoredSchedule {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<StoredSchedule>;
  if (typeof s.builtAtMs !== 'number' || !Number.isFinite(s.builtAtMs)) return false;
  const idx = s.index as Partial<ScheduleIndex> | undefined;
  if (typeof idx !== 'object' || idx === null) return false;
  if (typeof idx.byNumber !== 'object' || idx.byNumber === null) return false;
  if (typeof idx.byCallsign !== 'object' || idx.byCallsign === null) return false;
  return true;
}

/**
 * Read the table, or null if there isn't a usable one.
 *
 * Narrowing here rather than inside either backend is what keeps the storage
 * contract honest: a caller still cannot tell which implementation it has, and
 * both get the same guard. It also means consumers need none of their own --
 * refresh.ts used to hand-roll exactly this check before touching
 * `index.byNumber` while flights.ts had nothing, which is why the two behaved
 * completely differently on the same bad file.
 */
export async function loadSchedule(storage: ScheduleStorage): Promise<StoredSchedule | null> {
  const raw = await storage.read();
  if (raw === null) return null;
  if (!isStoredSchedule(raw)) {
    // Loud: this is a stored value that parsed but is not a table, which means
    // a hand-edited file or a rollback across an index-shape change. Silently
    // returning null would read as "no schedule yet" forever with no clue why.
    console.error('schedule: stored value is not a usable table; ignoring it');
    return null;
  }
  return raw;
}

export function isStale(s: StoredSchedule | null, nowMs: number): boolean {
  return s === null || nowMs - s.builtAtMs > STALE_AFTER_MS;
}
