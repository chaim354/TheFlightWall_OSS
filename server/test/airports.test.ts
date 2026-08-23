import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getAirportCoord, getAirportCoordByIata } from '../src/schedule/airports';
import { AIRPORT_TUPLES } from '../src/schedule/airports.data';

describe('getAirportCoord', () => {
  it('resolves a known major airport with coordinates matching reality', () => {
    // Spot-checked against independently known real-world reference points,
    // not against the generator's own source data -- the point is to catch
    // the generator (or a future regeneration) producing plausible-looking
    // but wrong numbers, not to restate what the CSV says. Precision 2
    // (~0.005 deg, on the order of 500 m at these latitudes) allows for
    // different providers picking a different point within the same large,
    // multi-runway airport -- it would not hide a wrong airport or a
    // swapped lat/lon.
    const jfk = getAirportCoord('KJFK');
    expect(jfk).toBeDefined();
    expect(jfk!.iata).toBe('JFK');
    expect(jfk!.lat).toBeCloseTo(40.6398, 2);
    expect(jfk!.lon).toBeCloseTo(-73.7789, 2);

    const egll = getAirportCoord('EGLL');
    expect(egll).toBeDefined();
    expect(egll!.iata).toBe('LHR');
    expect(egll!.lat).toBeCloseTo(51.4706, 2);
    expect(egll!.lon).toBeCloseTo(-0.4619, 2);

    // A third, independently: LAX's published field reference point is
    // 33.9425 N, 118.4081 W -- this one lands within precision 3.
    const klax = getAirportCoord('KLAX');
    expect(klax).toBeDefined();
    expect(klax!.iata).toBe('LAX');
    expect(klax!.lat).toBeCloseTo(33.9425, 3);
    expect(klax!.lon).toBeCloseTo(-118.4081, 3);
  });

  it('is case-insensitive on the ICAO code', () => {
    expect(getAirportCoord('kjfk')).toEqual(getAirportCoord('KJFK'));
  });

  it('returns undefined, not a throw, for an ICAO code the table does not have', () => {
    expect(getAirportCoord('ZZZZ')).toBeUndefined();
    expect(getAirportCoord('')).toBeUndefined();
    expect(() => getAirportCoord('not-an-icao-code')).not.toThrow();
  });
});

describe('getAirportCoordByIata', () => {
  // The Port Authority boards (src/schedule/panynj.ts) give ONLY IATA codes,
  // so this reverse lookup is the only route from those rows to coordinates.

  it('resolves the same airport the ICAO lookup does', () => {
    for (const [icao, iata] of [['KJFK', 'JFK'], ['KLGA', 'LGA'], ['KEWR', 'EWR'], ['KBOS', 'BOS'], ['SCEL', 'SCL'], ['TJSJ', 'SJU']]) {
      expect(getAirportCoordByIata(iata!)).toEqual(getAirportCoord(icao!));
    }
  });

  it('is case-insensitive and degrades to undefined rather than throwing', () => {
    expect(getAirportCoordByIata('jfk')).toEqual(getAirportCoordByIata('JFK'));
    expect(getAirportCoordByIata('ZZZ')).toBeUndefined();
    expect(getAirportCoordByIata('')).toBeUndefined();
    expect(() => getAirportCoordByIata('not-an-iata-code')).not.toThrow();
  });

  it('IATA codes are unique across the table, so inverting it picks no arbitrary winner', () => {
    // The safety property the reverse index rests on. Measured at 4,565
    // entries / 4,565 distinct IATA codes / 0 collisions -- but that is a
    // property of THIS filtered table, not of IATA codes generally, so a
    // future regeneration that admitted a duplicate would start silently
    // resolving one airport's code to another's coordinates. Read from the
    // exported table rather than hardcoded -- and rather than scraping the
    // generated source as text, which is what this had to do while the data
    // and the logic shared one file (F-SRV13-A).
    const tuples = AIRPORT_TUPLES;

    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [icao, t] of Object.entries(tuples)) {
      const prior = seen.get(t[0]);
      if (prior) collisions.push(`${t[0]}: ${prior} and ${icao}`);
      else seen.set(t[0], icao);
    }
    expect(collisions).toEqual([]);
    expect(seen.size).toBe(Object.keys(tuples).length);
    expect(seen.size).toBeGreaterThan(4000); // sanity: the parse really found the table
  });
});

describe('airport table covers every far-end airport in the captured fixture', () => {
  // This is the regression check for the failure mode this whole table
  // exists to avoid: a regeneration (or a hand edit, if anyone ever ignores
  // the GENERATED header) that silently drops coverage. It re-derives the
  // far-end ICAO set straight from the raw fixture JSON -- the same
  // traversal aerodatabox.ts's collect() uses (arrivals-array row -> far end
  // is `departure.airport`; departures-array row -> far end is
  // `arrival.airport`) -- rather than trusting a hardcoded list, so it stays
  // correct if the fixture is ever recaptured.
  const raw = JSON.parse(readFileSync(new URL('../fixtures/fids-kjfk.json', import.meta.url), 'utf8'));

  function farEndIcaos(payload: unknown): Set<string> {
    const b = payload as { arrivals?: unknown; departures?: unknown };
    const icaos = new Set<string>();
    const collect = (list: unknown, farSide: 'departure' | 'arrival') => {
      if (!Array.isArray(list)) return;
      for (const row of list as Record<string, unknown>[]) {
        const far = row?.[farSide] as Record<string, unknown> | undefined;
        const airport = far?.airport as Record<string, unknown> | undefined;
        const icao = airport?.icao;
        if (typeof icao === 'string' && icao.trim()) icaos.add(icao.trim().toUpperCase());
      }
    };
    collect(b?.arrivals, 'departure');
    collect(b?.departures, 'arrival');
    return icaos;
  }

  const farIcaos = farEndIcaos(raw);

  it('found a substantial set of distinct far-end airports to check (sanity on the check itself)', () => {
    // Guards against this test silently checking nothing if the fixture's
    // shape ever changes underneath it. README.md and airports.ts document
    // 109 for the current capture; asserting a floor rather than the exact
    // number keeps this from being just as brittle as a hardcoded list.
    expect(farIcaos.size).toBeGreaterThan(100);
  });

  it('resolves every distinct far-end ICAO the fixture contains', () => {
    const missing = [...farIcaos].filter((icao) => getAirportCoord(icao) === undefined).sort();
    expect(missing).toEqual([]);
  });
});

describe('generated/hand-written ownership boundary', () => {
  // F-SRV13-A: `npm run gen:airports` is a first-class package script, and it
  // used to write straight over src/schedule/airports.ts -- deleting
  // getAirportCoordByIata and the lazy IATA index, 42 lines the generator's
  // template never emitted, and with them the Port Authority provider's only
  // route to coordinates. The data now lives in its own module so regenerating
  // is a data-only diff that CANNOT remove logic. These assertions fail if the
  // two are ever merged back together.
  const genSrc = readFileSync(new URL('../tools/gen-airports.js', import.meta.url), 'utf8');

  function generatedFileName(): string {
    const m = genSrc.match(/DEFAULT_OUT\s*=\s*path\.join\([^)]*?'([\w.-]+\.ts)'\s*\)/);
    expect(m, 'could not find DEFAULT_OUT in tools/gen-airports.js').not.toBeNull();
    return m![1]!;
  }

  it('does not write to the module that defines the lookup functions', () => {
    expect(generatedFileName()).not.toBe('airports.ts');
  });

  it('emits data only -- no functions to lose on the next regeneration', () => {
    const generated = readFileSync(
      new URL(`../src/schedule/${generatedFileName()}`, import.meta.url), 'utf8');
    expect(generated).not.toMatch(/\bfunction\b/);
    expect(generated).toMatch(/export const AIRPORT_TUPLES/);
  });

  it('re-renders the committed data module byte-for-byte', async () => {
    // The check that would have caught F-SRV13-A: the template and its output
    // disagreed for two days with nothing comparing them. Catches STRUCTURAL
    // divergence -- header text, key order, encoding, and anything hand-added
    // to the generated file that the template does not emit (which is exactly
    // how the 42 lines of lookup logic came to be deleted on every run).
    // It cannot catch an edited coordinate VALUE, because the committed table
    // is this test's own input; the reference-point assertions at the top of
    // this file are what guard values, and they do catch that.
    const { renderModule } = await import('../tools/gen-airports.js');
    const committed = readFileSync(
      new URL(`../src/schedule/${generatedFileName()}`, import.meta.url), 'utf8');

    const date = committed.match(/Generated: (\d{4}-\d{2}-\d{2})\./)?.[1];
    expect(date, 'no generation date in the committed header').toBeDefined();

    expect(renderModule(AIRPORT_TUPLES, { date: date! })).toBe(committed);
  });

  it('keeps both lookups in the hand-owned module', () => {
    const handOwned = readFileSync(
      new URL('../src/schedule/airports.ts', import.meta.url), 'utf8');
    expect(handOwned).toMatch(/export function getAirportCoord\b/);
    expect(handOwned).toMatch(/export function getAirportCoordByIata\b/);
  });
});
