import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Flight } from './types';
import { airlineName } from './airlines';
// Shared with tracked/serve.ts, which needs the same parsing without this
// module's filesystem dependency.
import { carrierIataOf, normaliseCarrierCode, operatorIcaoOf } from './carrierCode';

export { carrierIataOf, normaliseCarrierCode, operatorIcaoOf };

/**
 * Operator code -> the name to show for it.
 *
 * WHY THIS EXISTS. A carrier with no entry in any table renders on the wall as
 * a bare code: Arkia flies as AIZ994 and the card reads "AIZ", because
 * src/airlines.ts is 44 marketing carriers, the firmware's own
 * utils/AirlineNames.h is 177 operating ones, and Arkia is in neither. Adding
 * it to the firmware table means a flash for a NAME, which is the thing this
 * project's OTA path exists to avoid; adding it to airlines.ts means a deploy.
 * This is the third option: a table a person can edit from the page, applied
 * server-side, so every board picks it up on its next fetch with nothing
 * flashed and nothing redeployed.
 *
 * DELIBERATELY NOT a replacement for either static table. Overrides are
 * consulted only where the answer would otherwise be null (see
 * applyAirlineOverrides), so a curated name always beats a typed one and the
 * blast radius of a mistake here is "one unnamed carrier stays wrong".
 */
export type AirlineOverrides = Record<string, string>;

export interface AirlineOverrideStorage {
  read(): Promise<AirlineOverrides>;
  write(overrides: AirlineOverrides): Promise<void>;
}

/**
 * Bound on the table, for the same reason MAX_ENTRIES bounds the tracked store:
 * this is writable by anyone holding the UI password, it lives on a small VPS,
 * and the whole file is parsed on every flights request. 200 is far more than
 * the long tail a single wall ever sees -- the two static tables together are
 * 221 carriers and they cover essentially all of it.
 */
export const MAX_OVERRIDES = 200;

/**
 * Names longer than this are refused rather than silently truncated.
 *
 * The mini card gives the airline 7 characters when a TRACKED label shares the
 * row and 14 otherwise, and the device truncates with an ellipsis. 24 is
 * generous against that -- it is a cap on absurdity (a pasted paragraph), not
 * a display budget, and the honest place to enforce a display budget is the
 * renderer that knows the panel width.
 */
export const MAX_NAME_LEN = 24;

/**
 * A display name, trimmed and collapsed, or null if it is not usable.
 *
 * Control characters are turned into spaces rather than rejected: they arrive
 * by paste, not by intent, and they would otherwise travel all the way to a
 * JSON field the device renders glyph by glyph.
 */
export function normaliseAirlineName(raw: string | undefined | null): string | null {
  const s = (raw ?? '')
    // Written as escapes rather than a literal range: a literal control
    // character in source is invisible in review and does not survive a
    // copy-paste intact.
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length === 0 || s.length > MAX_NAME_LEN) return null;
  return s;
}

/** One carrier code seen on the wall with no name to show for it. */
export interface UnnamedSighting {
  code: string;
  /** A callsign that carried it, so the person can tell what they are naming. */
  sample: string;
  lastSeenMs: number;
}

/**
 * The codes that actually rendered bare, most recent first.
 *
 * THIS IS THE FEATURE, not bookkeeping around it. Asking someone to type a code
 * they half-remember from across the room is asking them to get it wrong; the
 * useful question is "here is what your wall showed with no name -- which of
 * these do you want to fix?". Only codes that reached a card with a null `al`
 * are recorded, so the list is exactly the set of things that look broken and
 * nothing else.
 *
 * In memory, not on disk, and that is the right trade: it rebuilds within one
 * fetch interval of a restart, and persisting it would mean a disk write on
 * the request path for a hint.
 */
export interface UnnamedLog {
  note(code: string, sample: string, nowMs: number): void;
  list(): UnnamedSighting[];
  forget(code: string): void;
}

export function createUnnamedLog(limit = 40): UnnamedLog {
  const seen = new Map<string, UnnamedSighting>();
  return {
    note(code, sample, nowMs) {
      seen.set(code, { code, sample, lastSeenMs: nowMs });
      // Evict the least recently SEEN, not the least recently inserted: Map
      // preserves insertion order and `set` on an existing key does not move
      // it, so a code seen on every single request would otherwise age out
      // ahead of one seen once an hour ago. Cheap at this size, and wrong in a
      // way nobody would ever diagnose from the page.
      if (seen.size > limit) {
        let oldest: UnnamedSighting | null = null;
        for (const v of seen.values()) if (!oldest || v.lastSeenMs < oldest.lastSeenMs) oldest = v;
        if (oldest) seen.delete(oldest.code);
      }
    },
    list() {
      return [...seen.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    },
    forget(code) {
      seen.delete(code);
    },
  };
}

/**
 * Decide every card's `al`, in place, and record whatever is still nameless.
 *
 * PRECEDENCE, and the order is the interesting part:
 *
 *   1. A HAND-TYPED OVERRIDE WINS OUTRIGHT. This is a reversal of how it was
 *      first written -- overrides used to fill nulls only, on the theory that
 *      curated data should never be maskable by a typo. That theory does not
 *      survive contact with the generated table: it answers for ~6,000
 *      carriers, so under fill-nulls-only there would be almost nothing left
 *      for an override to fill, and the one thing a person actually wants to
 *      do -- shorten "Arkia Israel Inland Airlines" to "Arkia", because the
 *      card gives it 14 characters -- would be impossible. An explicit
 *      instruction from the person looking at the wall is the best evidence
 *      available about what that wall should say.
 *   2. Whatever a schedule row already resolved (enrich.ts, via the curated
 *      marketing table). Still ahead of the lookup below because it is keyed
 *      to the actual leg.
 *   3. The bundled tables, ICAO first -- see airlines.ts for why that order.
 *      ICAO before IATA because the ICAO code is what a live callsign yields
 *      and what the device would otherwise display.
 *   4. Nothing. The code is recorded so the page can offer to name it, and the
 *      device falls back to showing it bare.
 */
export function resolveAirlineNames(
  flights: Flight[],
  overrides: AirlineOverrides,
  nowMs: number,
  unnamed?: UnnamedLog,
): void {
  for (const f of flights) {
    const icao = operatorIcaoOf(f.cs);
    const iata = carrierIataOf(f.flt);

    const override = (icao ? overrides[icao] : undefined) ?? (iata ? overrides[iata] : undefined);
    if (override) {
      f.al = override;
      continue;
    }

    if (f.al) continue;

    const looked = (icao ? airlineName(icao) : null) ?? (iata ? airlineName(iata) : null);
    if (looked) {
      f.al = looked;
      continue;
    }

    // Nameless by every route. Record the code the wall is about to show bare
    // -- preferring ICAO, because that is the one it will actually display.
    const bare = icao ?? iata;
    if (bare && unnamed) unnamed.note(bare, f.cs, nowMs);
  }
}

/**
 * File-backed store, mirroring tracked/store.ts including the write-to-temp-
 * then-rename and the orphan cleanup on a failed write (see the comment there,
 * and commit 5b04ae4 -- on ENOSPC, a fresh UUID per attempt turns retries into
 * a feedback loop that eats the space that caused them).
 *
 * Every read failure degrades to an empty table rather than throwing. Airline
 * names are a cosmetic addition to /v1/flights, never a precondition for it: a
 * corrupt file must cost a few names, not the whole wall.
 */
export function fileAirlineOverrideStorage(path: string): AirlineOverrideStorage {
  return {
    async read(): Promise<AirlineOverrides> {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          console.error('airline overrides: file is not an object; ignoring');
          return {};
        }
        // Re-validated on the way IN, not only on the way through the API. The
        // file is editable by hand on the box, and a bad key here would
        // otherwise sit in memory being compared against every flight forever.
        const out: AirlineOverrides = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          const code = normaliseCarrierCode(k);
          const name = typeof v === 'string' ? normaliseAirlineName(v) : null;
          if (code && name) out[code] = name;
        }
        return out;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error(
            'airline overrides read failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
        return {};
      }
    },

    async write(overrides: AirlineOverrides): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(overrides), 'utf8');
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * GET /v1/airlines, POST /v1/airlines, DELETE /v1/airlines/{code}.
 *
 * GET returns the table AND the unnamed sightings together, in one round trip,
 * because the page renders them as one thing: the codes your wall is showing
 * bare, and the names you have already given. Two endpoints would mean two
 * polls that can disagree with each other by one interval.
 *
 * Every rejection carries a reason, for the same reason tracked/routes.ts's do
 * -- this endpoint IS the user interface, and a bare 400 leaves the person
 * guessing which of the code, the name or the cap they hit.
 */
export async function handleAirlines(
  method: string,
  url: URL,
  bodyText: string,
  storage: AirlineOverrideStorage,
  unnamed: UnnamedLog,
): Promise<Response> {
  const overrides = await storage.read();

  if (method === 'GET') {
    return json({ ok: true, overrides, unnamed: unnamed.list() });
  }

  if (method === 'POST') {
    let input: { code?: string; name?: string };
    try {
      input = JSON.parse(bodyText) as { code?: string; name?: string };
    } catch {
      return json({ ok: false, error: 'body must be JSON' }, 400);
    }

    const code = normaliseCarrierCode(input.code);
    if (!code) {
      return json({ ok: false, error: 'code must be 2-3 letters or digits, e.g. "AIZ"' }, 400);
    }
    const name = normaliseAirlineName(input.name);
    if (!name) {
      return json(
        { ok: false, error: `name must be 1-${MAX_NAME_LEN} characters` },
        400,
      );
    }
    // The cap applies to NEW codes only. Editing a name in a full table is not
    // the thing the cap exists to stop, and refusing it would strand the table
    // at exactly the size where a typo becomes uncorrectable.
    if (!(code in overrides) && Object.keys(overrides).length >= MAX_OVERRIDES) {
      return json(
        { ok: false, error: `at most ${MAX_OVERRIDES} airline names; delete one first` },
        400,
      );
    }

    await storage.write({ ...overrides, [code]: name });
    // Drop it from the sightings list immediately rather than waiting for the
    // next fetch to stop recording it. Otherwise the page keeps offering to
    // name a code that now HAS a name, for as long as it takes a board to come
    // round -- which reads as the save not having worked.
    unnamed.forget(code);
    return json({ ok: true, code, name });
  }

  if (method === 'DELETE') {
    const code = normaliseCarrierCode(decodeURIComponent(url.pathname.split('/').pop() ?? ''));
    if (!code || !(code in overrides)) {
      return json({ ok: false, error: 'no such airline name' }, 404);
    }
    const next = { ...overrides };
    delete next[code];
    await storage.write(next);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'method not allowed' }, 405);
}
