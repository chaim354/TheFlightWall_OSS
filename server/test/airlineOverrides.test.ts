import { describe, it, expect } from 'vitest';
import {
  resolveAirlineNames,
  createUnnamedLog,
  handleAirlines,
  MAX_NAME_LEN,
  MAX_OVERRIDES,
  normaliseAirlineName,
  type AirlineOverrideStorage,
  type AirlineOverrides,
} from '../src/airlineOverrides';
import type { Flight } from '../src/types';

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

/** A minimal area card. `al` null is the case this feature exists for. */
const flight = (over: Partial<Flight> = {}): Flight => ({
  cs: 'AIZ994', flt: null, al: null, reg: null, ac: null,
  from: null, to: null, alt: null, spd: null, hdg: null, vs: null,
  dst: 10, brg: 90, eta_min: null, eta_text: null, eta_src: null,
  ...over,
});

const memStorage = (initial: AirlineOverrides = {}): AirlineOverrideStorage & { current: AirlineOverrides } => {
  let current = { ...initial };
  return {
    get current() { return current; },
    read: async () => ({ ...current }),
    write: async (o) => { current = { ...o }; },
  };
};

describe('normaliseAirlineName', () => {
  it('trims and collapses whitespace', () => {
    expect(normaliseAirlineName('  Arkia   Israeli  ')).toBe('Arkia Israeli');
  });

  it('turns control characters into spaces rather than passing them to the panel', () => {
    // These arrive by paste. The device renders this string glyph by glyph.
    // Escapes, not literal bytes: a literal control character here is
    // invisible in review and would not survive a copy-paste.
    expect(normaliseAirlineName('Ark\u0000ia\u001F')).toBe('Ark ia');
    expect(normaliseAirlineName('Arkia\u007F')).toBe('Arkia');
  });

  it('is null for empty and for absurd lengths', () => {
    expect(normaliseAirlineName('')).toBeNull();
    expect(normaliseAirlineName('   ')).toBeNull();
    expect(normaliseAirlineName('x'.repeat(MAX_NAME_LEN))).toBe('x'.repeat(MAX_NAME_LEN));
    expect(normaliseAirlineName('x'.repeat(MAX_NAME_LEN + 1))).toBeNull();
  });
});

describe('resolveAirlineNames', () => {
  // QQQ / Q0 are checked-absent from all three bundled tables, so a test that
  // means "nobody knows this carrier" keeps meaning that.
  const unknown = (over: Partial<Flight> = {}) => flight({ cs: 'QQQ001', ...over });

  it('names a carrier that no table knew', () => {
    const flights = [unknown()];
    resolveAirlineNames(flights, { QQQ: 'Example Air' }, NOW);
    expect(flights[0]!.al).toBe('Example Air');
  });

  it('OVERRIDES a name the bundled tables supplied', () => {
    // The reversal, and the reason for it: the generated table answers for
    // ~6,400 carriers, so a fill-nulls-only override could almost never fire
    // -- and the thing a person actually wants is to SHORTEN what it said,
    // because the card gives the airline 14 characters.
    const flights = [flight({ cs: 'AIZ994' })];
    resolveAirlineNames(flights, {}, NOW);
    const generated = flights[0]!.al;
    expect(generated).not.toBeNull();

    const corrected = [flight({ cs: 'AIZ994' })];
    resolveAirlineNames(corrected, { AIZ: 'Arkia' }, NOW);
    expect(corrected[0]!.al).toBe('Arkia');
    expect(corrected[0]!.al).not.toBe(generated);
  });

  it('overrides a name the schedule already resolved, too', () => {
    // Same argument. An explicit instruction from the person looking at the
    // wall outranks every table, including the curated one.
    const flights = [flight({ cs: 'AIZ994', al: 'From The Schedule' })];
    resolveAirlineNames(flights, { AIZ: 'Arkia' }, NOW);
    expect(flights[0]!.al).toBe('Arkia');
  });

  it('keeps a schedule-resolved name when there is no override', () => {
    // Ahead of the lookup because it is keyed to the actual leg.
    const flights = [flight({ cs: 'AIZ994', al: 'From The Schedule' })];
    resolveAirlineNames(flights, {}, NOW);
    expect(flights[0]!.al).toBe('From The Schedule');
  });

  it('falls back to the IATA code when the callsign yields no ICAO', () => {
    // The fourth character must be a digit for a callsign to yield an operator
    // prefix (operatorIcaoOf, mirroring the firmware's parseAirlineIcao), so
    // this one yields none and the IATA half is the only route left. "BAW2LJ"
    // does NOT work here despite looking alphanumeric -- its fourth character
    // is a digit, so it resolves to BAW and British Airways, which is the
    // right answer to a different question.
    const flights = [unknown({ cs: 'QQQAB', flt: 'Q0994' })];
    resolveAirlineNames(flights, { Q0: 'Example Air' }, NOW);
    expect(flights[0]!.al).toBe('Example Air');
  });

  it('prefers the ICAO entry, because that is the code the person saw', () => {
    const flights = [unknown({ cs: 'QQQ994', flt: 'Q0994' })];
    resolveAirlineNames(flights, { QQQ: 'from ICAO', Q0: 'from IATA' }, NOW);
    expect(flights[0]!.al).toBe('from ICAO');
  });

  it('resolves the long tail from the bundled tables with no override at all', () => {
    // The case this whole change exists for: Arkia flies AIZ994 into JFK daily
    // and the card read "AIZ".
    const flights = [flight({ cs: 'AIZ994' })];
    resolveAirlineNames(flights, {}, NOW);
    expect(flights[0]!.al).not.toBeNull();
  });

  it('records what stayed bare, with a sample callsign', () => {
    const log = createUnnamedLog();
    resolveAirlineNames([unknown()], {}, NOW, log);
    expect(log.list()).toEqual([{ code: 'QQQ', sample: 'QQQ001', lastSeenMs: NOW }]);
  });

  it('records nothing for a carrier a table could name', () => {
    const log = createUnnamedLog();
    resolveAirlineNames([flight({ cs: 'AIZ994' })], {}, NOW, log);
    expect(log.list()).toEqual([]);
  });

  it('records nothing for a private tail number', () => {
    // There is no carrier to name, so offering one would be noise in the exact
    // list that is supposed to be all signal.
    const log = createUnnamedLog();
    resolveAirlineNames([unknown({ cs: 'N172SP' })], {}, NOW, log);
    expect(log.list()).toEqual([]);
  });
});

describe('createUnnamedLog', () => {
  it('lists most recently seen first', () => {
    const log = createUnnamedLog();
    log.note('AAA', 'AAA1', NOW);
    log.note('BBB', 'BBB1', NOW + 1000);
    expect(log.list().map((s) => s.code)).toEqual(['BBB', 'AAA']);
  });

  it('evicts the least recently SEEN, not the least recently added', () => {
    // Map keeps insertion order and `set` on an existing key does not move it,
    // so a naive first-key eviction drops the code seen on every request and
    // keeps a stale one -- backwards, and invisible from the page.
    const log = createUnnamedLog(2);
    log.note('OLD', 'OLD1', NOW);
    log.note('MID', 'MID1', NOW + 1000);
    log.note('OLD', 'OLD2', NOW + 2000); // OLD is now the freshest
    log.note('NEW', 'NEW1', NOW + 3000); // pushes over the limit
    expect(log.list().map((s) => s.code).sort()).toEqual(['NEW', 'OLD']);
  });
});

describe('handleAirlines', () => {
  const url = (p = '/v1/airlines') => new URL(`http://localhost${p}`);

  it('returns the table and the sightings in one round trip', async () => {
    const log = createUnnamedLog();
    log.note('AIZ', 'AIZ994', NOW);
    const res = await handleAirlines('GET', url(), '', memStorage({ XYZ: 'Example' }), log);
    const body = (await res.json()) as { ok: boolean; overrides: AirlineOverrides; unnamed: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.overrides).toEqual({ XYZ: 'Example' });
    expect(body.unnamed).toHaveLength(1);
  });

  it('stores a normalised name', async () => {
    const storage = memStorage();
    const res = await handleAirlines('POST', url(), JSON.stringify({ code: ' aiz ', name: '  Arkia  ' }), storage, createUnnamedLog());
    expect(res.status).toBe(200);
    expect(storage.current).toEqual({ AIZ: 'Arkia' });
  });

  it('drops the code from the sightings as soon as it is named', async () => {
    // Otherwise the page keeps offering to name a code that now has a name,
    // until a board next fetches -- which reads as the save not having worked.
    const log = createUnnamedLog();
    log.note('AIZ', 'AIZ994', NOW);
    await handleAirlines('POST', url(), JSON.stringify({ code: 'AIZ', name: 'Arkia' }), memStorage(), log);
    expect(log.list()).toEqual([]);
  });

  it('rejects a bad code and a bad name with reasons, storing nothing', async () => {
    const storage = memStorage();
    const bad = await handleAirlines('POST', url(), JSON.stringify({ code: 'TOOLONG', name: 'x' }), storage, createUnnamedLog());
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('code must be');

    const noName = await handleAirlines('POST', url(), JSON.stringify({ code: 'AIZ', name: '  ' }), storage, createUnnamedLog());
    expect(noName.status).toBe(400);
    expect(((await noName.json()) as { error: string }).error).toContain('name must be');

    expect(storage.current).toEqual({});
  });

  it('rejects a body that is not JSON', async () => {
    const res = await handleAirlines('POST', url(), 'not json', memStorage(), createUnnamedLog());
    expect(res.status).toBe(400);
  });

  it('caps NEW codes but still allows editing an existing one at the cap', async () => {
    // A full table must not become uncorrectable: refusing an edit strands a
    // typo at exactly the size where it is hardest to fix.
    const full: AirlineOverrides = {};
    for (let i = 0; i < MAX_OVERRIDES; i++) full[`A${String(i).padStart(2, '0')}`] = `n${i}`;
    const storage = memStorage(full);

    const added = await handleAirlines('POST', url(), JSON.stringify({ code: 'ZZZ', name: 'Nope' }), storage, createUnnamedLog());
    expect(added.status).toBe(400);
    expect(((await added.json()) as { error: string }).error).toContain('at most');

    const edited = await handleAirlines('POST', url(), JSON.stringify({ code: 'A00', name: 'Renamed' }), storage, createUnnamedLog());
    expect(edited.status).toBe(200);
    expect(storage.current.A00).toBe('Renamed');
  });

  it('deletes by code, and 404s an unknown one', async () => {
    const storage = memStorage({ AIZ: 'Arkia' });
    const gone = await handleAirlines('DELETE', url('/v1/airlines/aiz'), '', storage, createUnnamedLog());
    expect(gone.status).toBe(200);
    expect(storage.current).toEqual({});

    const missing = await handleAirlines('DELETE', url('/v1/airlines/XXX'), '', storage, createUnnamedLog());
    expect(missing.status).toBe(404);
  });

  it('refuses other methods', async () => {
    const res = await handleAirlines('PATCH', url(), '', memStorage(), createUnnamedLog());
    expect(res.status).toBe(405);
  });
});
