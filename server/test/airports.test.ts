import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getAirportCoord, getAirportCoordByIata } from '../src/schedule/airports';

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
    // resolving one airport's code to another's coordinates. Re-derived from
    // the generated source rather than hardcoded.
    const src = readFileSync(new URL('../src/schedule/airports.ts', import.meta.url), 'utf8');
    const start = src.indexOf('{"', src.indexOf('AIRPORT_TUPLES'));
    const semi = src.indexOf(';', start);
    const tuples = JSON.parse(src.slice(start, src.lastIndexOf('}', semi) + 1)) as Record<string, [string, number, number]>;

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
