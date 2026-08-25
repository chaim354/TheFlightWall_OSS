import { randomUUID } from 'node:crypto';
import type { TrackedEntry, TrackedSource } from './types';
import type { TrackedStorage } from './store';
import { startOfUtcDay } from './lifecycle';

/**
 * Hard cap on stored entries.
 *
 * Load-bearing, not cosmetic: this endpoint is unauthenticated by explicit
 * decision, so this and the date window below are what stop a stranger who
 * finds the URL from queueing unbounded work. Keep it consistent with the
 * daily resolution ceiling in tick.ts -- 20 entries x 2 calls each is 40, and
 * a ceiling below that would deadlock a legitimately full store.
 */
export const MAX_ENTRIES = 20;
const DAY_MS = 24 * 60 * 60_000;
export const WINDOW_PAST_DAYS = 1;
export const WINDOW_FUTURE_DAYS = 14;

/**
 * Carrier prefix (2-3 alphanumerics, e.g. "9W" or "BA") then 1-4 digits.
 * "ba 181" -> "BA181".
 *
 * The prefix must contain at least one letter, not just be alphanumeric --
 * [A-Z0-9]{2,3}\d{1,4} alone also matches a bare "181" as carrier "18" +
 * flight "1", which is not a flight number at all. Every real IATA/ICAO
 * carrier code has a letter in it, so this rejects that split without
 * rejecting genuine mixed-alnum codes like "9W2381" or "W6123".
 */
export function normaliseNumber(raw: string): string | null {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  const m = /^([A-Z0-9]{2,3})(\d{1,4})$/.exec(s);
  if (!m) return null;
  const prefix = m[1]!;
  return /[A-Z]/.test(prefix) ? s : null;
}

/**
 * First and last acceptable day, as midnight-UTC instants.
 *
 * One definition, used by validateEntry below and by isDateInWindow beside it.
 * The two callers need different things from the same arithmetic -- the
 * endpoint needs to say WHICH end was missed, the sync only needs yes or no --
 * and computing the bounds separately in each would be two chances for them to
 * disagree about what is trackable.
 */
function windowBounds(nowMs: number): { firstMs: number; lastMs: number } {
  const todayMs = startOfUtcDay(new Date(nowMs).toISOString().slice(0, 10));
  return {
    firstMs: todayMs - WINDOW_PAST_DAYS * DAY_MS,
    lastMs: todayMs + WINDOW_FUTURE_DAYS * DAY_MS,
  };
}

/**
 * Is this ISO date inside the accepted today-1 .. today+14 window?
 *
 * The calendar sync (src/tracked/sync.ts) asks this twice: once to filter the
 * feed, and once to decide whether an ageing entry is still its business
 * rather than lifecycle's.
 *
 * NaN for a malformed date is false, not a throw -- an unparseable date is
 * simply not in the window.
 */
export function isDateInWindow(date: string, nowMs: number): boolean {
  const dayMs = startOfUtcDay(date);
  if (Number.isNaN(dayMs)) return false;
  const { firstMs, lastMs } = windowBounds(nowMs);
  return dayMs >= firstMs && dayMs <= lastMs;
}

export interface EntryInput {
  number: string;
  date: string;
}

export type Validation =
  | { ok: true; number: string; date: string }
  | { ok: false; reason: string };

/**
 * Every rejection carries a reason because this endpoint IS the user interface
 * -- there is no form to show a validation message, so a bare 400 would leave
 * the user guessing which of the number, the date or the cap they hit.
 */
export function validateEntry(input: EntryInput, nowMs: number, currentCount: number): Validation {
  if (currentCount >= MAX_ENTRIES) {
    return { ok: false, reason: `at most ${MAX_ENTRIES} tracked flights; delete one first` };
  }

  const number = normaliseNumber(input.number ?? '');
  if (!number) {
    return { ok: false, reason: 'flight number must look like "BA181"' };
  }

  const dayMs = startOfUtcDay(input.date ?? '');
  if (Number.isNaN(dayMs)) {
    return { ok: false, reason: 'date must be YYYY-MM-DD' };
  }

  const { firstMs, lastMs } = windowBounds(nowMs);
  if (dayMs < firstMs) {
    return { ok: false, reason: 'date is in the past' };
  }
  if (dayMs > lastMs) {
    return { ok: false, reason: `date is more than ${WINDOW_FUTURE_DAYS} days ahead` };
  }

  return { ok: true, number, date: input.date };
}

/**
 * `source` defaults to 'manual' rather than being required, because manual is
 * what every pre-existing caller meant: this endpoint is a person typing into
 * a form. Only the calendar sync passes anything else, and only it is allowed
 * to delete what it passed.
 */
export function newEntry(
  number: string,
  date: string,
  nowMs: number,
  source: TrackedSource = 'manual',
): TrackedEntry {
  return {
    id: randomUUID(),
    number,
    date,
    state: 'pending',
    reason: null,
    attempts: 0,
    stateAtMs: nowMs,
    reresolved: false,
    source,
    icao24: null,
    callsign: null,
    reg: null,
    aircraftModel: null,
    aircraftType: null,
    origIata: null,
    destIata: null,
    orig: null,
    dest: null,
    schedDepEpoch: null,
    schedArrEpoch: null,
    lastLat: null,
    lastLon: null,
    lastPosAtMs: null,
    lastAltFt: null,
    lastGroundspeedKt: null,
    lastHeadingDeg: null,
    lastVerticalRateFpm: null,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** GET /v1/tracked, POST /v1/tracked, DELETE /v1/tracked/{id}. */
export async function handleTracked(
  method: string,
  url: URL,
  bodyText: string,
  storage: TrackedStorage,
  nowMs: number,
): Promise<Response> {
  const entries = await storage.read();

  if (method === 'GET') {
    return json({ ok: true, entries });
  }

  if (method === 'POST') {
    let input: EntryInput;
    try {
      input = JSON.parse(bodyText) as EntryInput;
    } catch {
      return json({ ok: false, error: 'body must be JSON' }, 400);
    }

    // Idempotent on (number, date): re-POSTing an already-tracked journey
    // must return the existing entry rather than consuming a second slot
    // against the cap. This has to run BEFORE validateEntry's cap check, not
    // after -- checking after means that once the store is exactly full,
    // validateEntry rejects every call (including a repost of an entry
    // already counted in that fullness) with "store is full" before the
    // idempotency lookup ever runs, which breaks idempotency at precisely
    // the boundary where a retried POST is most likely to land.
    const number = normaliseNumber(input.number ?? '');
    if (number) {
      const existing = entries.find((e) => e.number === number && e.date === input.date);
      if (existing) return json({ ok: true, entry: existing });
    }

    const v = validateEntry(input, nowMs, entries.length);
    if (!v.ok) return json({ ok: false, error: v.reason }, 400);

    const entry = newEntry(v.number, v.date, nowMs);
    await storage.write([...entries, entry]);
    return json({ ok: true, entry }, 201);
  }

  if (method === 'DELETE') {
    const id = url.pathname.split('/').pop() ?? '';
    const remaining = entries.filter((e) => e.id !== id);
    if (remaining.length === entries.length) {
      return json({ ok: false, error: 'no such entry' }, 404);
    }
    await storage.write(remaining);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'method not allowed' }, 405);
}
