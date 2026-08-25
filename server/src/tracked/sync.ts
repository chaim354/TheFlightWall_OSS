import type { TrackedEntry } from './types';
import type { TrackedStorage } from './store';
import { isDateInWindow, newEntry, MAX_ENTRIES } from './routes';
import { parseCalendarFlights, type CalendarFlight } from './calendar';

export interface ReconcileResult {
  next: TrackedEntry[];
  added: number;
  deleted: number;
  /** Feed flights that did not fit under MAX_ENTRIES. Logged, never silent. */
  skipped: number;
  /** In-window feed flights whose date came from a TZID, and so is origin-local. */
  zonedDates: number;
  /**
   * In-window feed flights whose date is only a UTC reading, because DTSTART
   * carried a `Z` instant, a floating time, or no time at all.
   *
   * Reported so server.ts can log it: a non-zero count means dates may be a day
   * LATE for a late-evening westbound departure, and knowing which regime the
   * feed uses is the difference between diagnosing that in a minute and
   * rediscovering it from first principles.
   */
  floatingDates: number;
}

/** (number, date) -- the same key the store's own idempotency uses. */
const key = (number: string, date: string): string => `${number}|${date}`;

/**
 * Fold the feed into the store: what the sync WOULD do, without doing it.
 *
 * Pure, and separate from runCalendarSync below for the same reason
 * lifecycle.ts is separate from tick.ts -- the interesting rules should be
 * testable with no network and no clock control, and this file's one dangerous
 * capability (deleting entries) should be readable in isolation.
 *
 * Deletions run BEFORE additions, so a journey dropped from the calendar frees
 * its slot for a new one in the same pass. The other order leaves a full store
 * unable to accept a replacement until the following hour.
 */
export function reconcile(
  entries: TrackedEntry[],
  flights: CalendarFlight[],
  nowMs: number,
): ReconcileResult {
  const inWindow = flights.filter((f) => isDateInWindow(f.date, nowMs));
  const feedKeys = new Set(inWindow.map((f) => key(f.number, f.date)));

  /**
   * An entry is the sync's to delete only when all four hold. Each clause
   * stops one specific way of destroying something the user wanted:
   *
   * - `source === 'calendar'` -- never touch a hand-added entry, and never
   *   touch one stored before the field existed (null reads as manual).
   * - `state !== 'airborne'` -- the wall is showing an aircraft that is
   *   genuinely in the air. If Flighty tidies the event mid-flight, let
   *   lifecycle expire it 2h after landing instead of yanking the card.
   * - still in the window -- an entry ageing past today-1 leaves the feed set
   *   for reasons that have nothing to do with the calendar, and expiring it
   *   is lifecycle's job. One owner per transition, not two.
   * - absent from the feed -- the actual signal.
   */
  const survivors = entries.filter(
    (e) =>
      !(
        e.source === 'calendar' &&
        e.state !== 'airborne' &&
        isDateInWindow(e.date, nowMs) &&
        !feedKeys.has(key(e.number, e.date))
      ),
  );
  const deleted = entries.length - survivors.length;

  const held = new Set(survivors.map((e) => key(e.number, e.date)));
  const next = [...survivors];
  let added = 0;
  let skipped = 0;

  // inWindow arrives sorted soonest-first from parseCalendarFlights, so a feed
  // with more flights than fit keeps the nearest ones -- the far end of a
  // fortnight is what you can afford to lose.
  for (const f of inWindow) {
    const k = key(f.number, f.date);
    if (held.has(k)) continue;
    if (next.length >= MAX_ENTRIES) {
      skipped++;
      continue;
    }
    held.add(k);
    next.push(newEntry(f.number, f.date, nowMs, 'calendar'));
    added++;
  }

  const zonedDates = inWindow.filter((f) => f.tzid !== null).length;

  return {
    next,
    added,
    deleted,
    skipped,
    zonedDates,
    floatingDates: inWindow.length - zonedDates,
  };
}

export interface SyncDeps {
  /** The feed body, or null if it could not be fetched. Never throws. */
  fetchIcs(): Promise<string | null>;
}

/**
 * One calendar pass: fetch, parse, reconcile, write.
 *
 * A FAILED FETCH MAKES NO CHANGE AT ALL -- no adds, and crucially no deletes.
 * Without that, a single transient 503 from iCloud reads as "the calendar is
 * empty" and wipes every tracked flight, which is both the worst outcome
 * available here and the most likely one to happen unattended at 3am. An
 * empty feed that genuinely PARSED is different, and does delete.
 *
 * The store is written only when something actually changed, so a quiet
 * fortnight costs no disk writes.
 */
export async function runCalendarSync(
  storage: TrackedStorage,
  nowMs: number,
  deps: SyncDeps,
): Promise<ReconcileResult | null> {
  const text = await deps.fetchIcs();
  if (text === null) return null;

  const flights = parseCalendarFlights(text);
  const entries = await storage.read();
  const result = reconcile(entries, flights, nowMs);

  if (result.added > 0 || result.deleted > 0) {
    await storage.write(result.next);
  }
  return result;
}
