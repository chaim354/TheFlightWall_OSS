import { describe, it, expect } from 'vitest';
import {
  normaliseIata,
  normaliseNumber,
  validateEntry,
  handleTracked,
  newEntry,
  MAX_ENTRIES,
} from '../../src/tracked/routes';
import type { TrackedStorage } from '../../src/tracked/store';
import type { TrackedEntry } from '../../src/tracked/types';

const TODAY = Date.UTC(2026, 8, 14);

describe('normaliseNumber', () => {
  it('uppercases and strips spaces', () => {
    expect(normaliseNumber('ba 181')).toBe('BA181');
    expect(normaliseNumber('  dl405 ')).toBe('DL405');
  });

  it('rejects anything that is not carrier+digits', () => {
    for (const bad of ['', '181', 'BA', 'B!181', 'BA181X9', 'a'.repeat(20)]) {
      expect(normaliseNumber(bad)).toBeNull();
    }
  });
});

describe('validateEntry', () => {
  it('accepts today and dates inside the window', () => {
    expect(validateEntry({ number: 'BA181', date: '2026-09-14' }, TODAY, 0).ok).toBe(true);
    expect(validateEntry({ number: 'BA181', date: '2026-09-28' }, TODAY, 0).ok).toBe(true);
    expect(validateEntry({ number: 'BA181', date: '2026-09-13' }, TODAY, 0).ok).toBe(true);
  });

  it('rejects dates outside today-1..today+14', () => {
    // Bounds what a stranger can queue up, and rejects backfill attempts.
    expect(validateEntry({ number: 'BA181', date: '2026-09-12' }, TODAY, 0).ok).toBe(false);
    expect(validateEntry({ number: 'BA181', date: '2026-09-29' }, TODAY, 0).ok).toBe(false);
  });

  it('rejects a malformed date rather than guessing', () => {
    expect(validateEntry({ number: 'BA181', date: '14/09/2026' }, TODAY, 0).ok).toBe(false);
    expect(validateEntry({ number: 'BA181', date: '' }, TODAY, 0).ok).toBe(false);
  });

  it('rejects a bad flight number', () => {
    expect(validateEntry({ number: '!!', date: '2026-09-14' }, TODAY, 0).ok).toBe(false);
  });

  it('rejects once the store is full', () => {
    expect(validateEntry({ number: 'BA181', date: '2026-09-14' }, TODAY, MAX_ENTRIES).ok).toBe(false);
    expect(validateEntry({ number: 'BA181', date: '2026-09-14' }, TODAY, MAX_ENTRIES - 1).ok).toBe(true);
  });

  it('gives a reason on every rejection', () => {
    // The endpoint is the only UI. "400" with no reason is unusable.
    const r = validateEntry({ number: 'BA181', date: '2026-01-01' }, TODAY, 0);
    expect(r.ok).toBe(false);
    // `expect(r.ok).toBe(false)` doesn't narrow `r` for the type checker --
    // only a real `if` does -- so an explicit guard is needed before
    // `r.reason` is accessible under this repo's strict tsconfig.
    if (r.ok) throw new Error('unreachable: r.ok was asserted false above');
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

// In-memory TrackedStorage, standing in for fileTrackedStorage the same way
// FakeKV stands in for the Workers KV binding in test/flights.test.ts: enough
// to exercise handleTracked's own logic with no filesystem involved.
function memStorage(initial: TrackedEntry[] = []): TrackedStorage {
  let entries = initial;
  return {
    read: async () => entries,
    write: async (next) => {
      entries = next;
    },
  };
}

describe('normaliseIata', () => {
  it('uppercases and strips whitespace', () => {
    expect(normaliseIata('  jfk ')).toBe('JFK');
    expect(normaliseIata('Lhr')).toBe('LHR');
  });

  it('is null for blank, absent, and anything that is not three letters', () => {
    for (const v of ['', '   ', undefined, null, 'JF', 'JFKK', 'JF1', '123']) {
      expect(normaliseIata(v)).toBeNull();
    }
  });
});

describe('validateEntry: requested route', () => {
  it('defaults to no preference, which is the pre-existing behaviour', () => {
    const v = validateEntry({ number: 'BA181', date: '2026-09-14' }, TODAY, 0);
    if (!v.ok) throw new Error(v.reason);
    expect(v.wantOrigIata).toBeNull();
    expect(v.wantDestIata).toBeNull();
  });

  it('normalises a route that was given', () => {
    const v = validateEntry({ number: 'BA181', date: '2026-09-14', from: 'jfk', to: ' lhr ' }, TODAY, 0);
    if (!v.ok) throw new Error(v.reason);
    expect(v.wantOrigIata).toBe('JFK');
    expect(v.wantDestIata).toBe('LHR');
  });

  it('accepts one half without the other', () => {
    const v = validateEntry({ number: 'BA181', date: '2026-09-14', from: 'JFK' }, TODAY, 0);
    if (!v.ok) throw new Error(v.reason);
    expect(v.wantOrigIata).toBe('JFK');
    expect(v.wantDestIata).toBeNull();
  });

  it('REJECTS a malformed code rather than ignoring it', () => {
    // The whole point of the field is to stop the clock heuristic guessing.
    // Treating a typo as "no preference" would hand back a confidently-wrong
    // aeroplane from the one input added to prevent exactly that.
    const bad = validateEntry({ number: 'BA181', date: '2026-09-14', from: 'JFKK' }, TODAY, 0);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.reason).toContain('3-letter IATA');

    const badTo = validateEntry({ number: 'BA181', date: '2026-09-14', to: '1' }, TODAY, 0);
    expect(badTo.ok).toBe(false);
  });

  it('treats an all-whitespace field as blank, not as a mistake', () => {
    const v = validateEntry({ number: 'BA181', date: '2026-09-14', from: '  ' }, TODAY, 0);
    expect(v.ok).toBe(true);
  });
});

describe('handleTracked: POST idempotency', () => {
  // The endpoint is unauthenticated (see routes.ts), so MAX_ENTRIES is the
  // only thing bounding a stranger's spend. That guarantee is worthless if
  // reposting the SAME journey can eat a second slot -- a client retrying a
  // POST whose response it never saw must land back on the entry that
  // already exists, not on a duplicate.
  it('does not grow the store when the same (number, date) is posted twice', async () => {
    const storage = memStorage();
    const body = JSON.stringify({ number: 'ba 181', date: '2026-09-14' });
    const url = new URL('http://localhost/v1/tracked');

    const first = await handleTracked('POST', url, body, storage, TODAY);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { ok: boolean; entry: TrackedEntry };

    const second = await handleTracked('POST', url, body, storage, TODAY);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { ok: boolean; entry: TrackedEntry };
    expect(secondBody.entry.id).toBe(firstBody.entry.id);

    expect((await storage.read()).length).toBe(1);
  });

  it('reposting an already-tracked flight succeeds even when the store is at the cap', async () => {
    // Idempotency has to hold exactly where it matters most: once the store
    // is full, a retry of an existing entry must still return that entry
    // rather than being turned away by the guard meant for genuinely NEW
    // entries. A `write` that throws proves the fix does not work by
    // accident -- the entry must come back without touching storage at all.
    const target = newEntry('BA181', '2026-09-20', TODAY);
    const full: TrackedEntry[] = Array.from({ length: MAX_ENTRIES }, (_, i) =>
      i === 0 ? target : newEntry(`XX${i}`, '2026-09-14', TODAY),
    );
    const storage: TrackedStorage = {
      read: async () => full,
      write: async () => {
        throw new Error('must not write: this POST should be idempotent');
      },
    };

    const res = await handleTracked(
      'POST',
      new URL('http://localhost/v1/tracked'),
      JSON.stringify({ number: 'BA181', date: '2026-09-20' }),
      storage,
      TODAY,
    );

    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { ok: boolean; entry: TrackedEntry };
    expect(resBody.ok).toBe(true);
    expect(resBody.entry.id).toBe(target.id);
  });

  it('treats the two legs of a rotation as different journeys', async () => {
    // Same number, same date, opposite directions -- two aeroplanes. Keying
    // idempotency on (number, date) alone would hand the second request the
    // first one's entry, which is the reused-number bug reappearing inside
    // the endpoint added to fix it.
    const storage = memStorage();
    const url = new URL('http://localhost/v1/tracked');

    const out = await handleTracked('POST', url,
      JSON.stringify({ number: 'BA181', date: '2026-09-14', from: 'LHR', to: 'JFK' }), storage, TODAY);
    const back = await handleTracked('POST', url,
      JSON.stringify({ number: 'BA181', date: '2026-09-14', from: 'JFK', to: 'LHR' }), storage, TODAY);

    expect(out.status).toBe(201);
    expect(back.status).toBe(201);
    const stored = await storage.read();
    expect(stored.length).toBe(2);
    expect(stored.map((e) => e.wantOrigIata)).toEqual(['LHR', 'JFK']);
  });

  it('is still idempotent when the same route is posted twice', async () => {
    const storage = memStorage();
    const url = new URL('http://localhost/v1/tracked');
    const body = JSON.stringify({ number: 'BA181', date: '2026-09-14', from: 'jfk' });

    const first = await handleTracked('POST', url, body, storage, TODAY);
    const second = await handleTracked('POST', url, body, storage, TODAY);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await storage.read()).length).toBe(1);
  });

  it('stores the requested route on the entry', async () => {
    const storage = memStorage();
    const res = await handleTracked('POST', new URL('http://localhost/v1/tracked'),
      JSON.stringify({ number: 'ba 181', date: '2026-09-14', from: ' jfk', to: 'lhr' }), storage, TODAY);
    const body = (await res.json()) as { entry: TrackedEntry };
    expect(body.entry.wantOrigIata).toBe('JFK');
    expect(body.entry.wantDestIata).toBe('LHR');
  });

  it('rejects a malformed route with the reason, and stores nothing', async () => {
    const storage = memStorage();
    const res = await handleTracked('POST', new URL('http://localhost/v1/tracked'),
      JSON.stringify({ number: 'BA181', date: '2026-09-14', from: 'JFKK' }), storage, TODAY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('3-letter IATA');
    expect((await storage.read()).length).toBe(0);
  });
});
