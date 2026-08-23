import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAdsbLol } from '../src/adsblol';

const raw = JSON.parse(readFileSync(new URL('../fixtures/adsblol-jfk.json', import.meta.url), 'utf8'));

describe('parseAdsbLol', () => {
  const aircraft = parseAdsbLol(raw);

  it('parses every aircraft that has a position', () => {
    expect(aircraft.length).toBeGreaterThan(50);
    for (const a of aircraft) {
      expect(Number.isFinite(a.lat)).toBe(true);
      expect(Number.isFinite(a.lon)).toBe(true);
    }
  });

  it('trims the callsign', () => {
    for (const a of aircraft) expect(a.callsign).toBe(a.callsign.trim());
  });

  it('carries registration and type inline, so no per-flight lookup is needed', () => {
    const withType = aircraft.filter((a) => a.typeIcao);
    const withReg = aircraft.filter((a) => a.registration);
    expect(withType.length / aircraft.length).toBeGreaterThan(0.8);
    expect(withReg.length / aircraft.length).toBeGreaterThan(0.8);
  });

  it('carries precomputed distance and bearing', () => {
    const withDst = aircraft.filter((a) => a.distanceNm !== null);
    expect(withDst.length / aircraft.length).toBeGreaterThan(0.9);
  });

  it('treats a ground-string altitude as on-ground rather than NaN', () => {
    // adsb.lol reports alt_baro as the string "ground" for surface aircraft.
    const parsed = parseAdsbLol({ ac: [{ hex: 'abc123', flight: 'TEST1 ', lat: 40, lon: -73, alt_baro: 'ground' }] });
    expect(parsed[0]!.onGround).toBe(true);
    expect(parsed[0]!.altFt).toBeNull();
  });

  it('drops rows with no position', () => {
    const parsed = parseAdsbLol({ ac: [{ hex: 'abc123', flight: 'TEST1' }] });
    expect(parsed).toHaveLength(0);
  });

  it('survives a malformed payload without throwing', () => {
    expect(parseAdsbLol({})).toEqual([]);
    expect(parseAdsbLol({ ac: null })).toEqual([]);
  });

  it('degrades a wrong-typed string field to empty/null instead of throwing', () => {
    // hex/flight/r/t/category are declared as strings but nothing guarantees
    // that at runtime -- an upstream schema change could ship any of them as
    // a number or boolean. A bad field must not crash the row.
    const base = { hex: 'abc123', flight: 'TEST1', lat: 40, lon: -73 };
    expect(() => parseAdsbLol({ ac: [{ ...base, r: 12345 }] })).not.toThrow();
    expect(() => parseAdsbLol({ ac: [{ ...base, t: 12345 }] })).not.toThrow();
    expect(() => parseAdsbLol({ ac: [{ ...base, category: true }] })).not.toThrow();
    expect(() => parseAdsbLol({ ac: [{ ...base, hex: 999 }] })).not.toThrow();
    expect(() => parseAdsbLol({ ac: [{ ...base, flight: 12345 }] })).not.toThrow();

    expect(parseAdsbLol({ ac: [{ ...base, r: 12345 }] })[0]!.registration).toBeNull();
    expect(parseAdsbLol({ ac: [{ ...base, t: 12345 }] })[0]!.typeIcao).toBeNull();
    expect(parseAdsbLol({ ac: [{ ...base, category: true }] })[0]!.category).toBeNull();
    expect(parseAdsbLol({ ac: [{ ...base, hex: 999 }] })[0]!.hex).toBe('');
    expect(parseAdsbLol({ ac: [{ ...base, flight: 12345 }] })[0]!.callsign).toBe('');
  });

  it('degrades only the malformed row, not the whole batch', () => {
    // Partial degradation is the point: one bad row from an upstream schema
    // change must not blank out every other aircraft in the same response.
    const parsed = parseAdsbLol({
      ac: [
        { hex: 'aaa111', flight: 'GOOD1', r: 'N123AB', t: 'B738', lat: 40.1, lon: -73.1 },
        { hex: 'bbb222', flight: 'BAD1', r: 12345, t: true, category: 42, lat: 40.2, lon: -73.2 },
        { hex: 'ccc333', flight: 'GOOD2', r: 'N456CD', t: 'A320', lat: 40.3, lon: -73.3 },
      ],
    });

    expect(parsed).toHaveLength(3);
    expect(parsed.map((a) => a.callsign)).toEqual(['GOOD1', 'BAD1', 'GOOD2']);

    const [good1, bad, good2] = parsed;
    expect(good1!.registration).toBe('N123AB');
    expect(good1!.typeIcao).toBe('B738');
    expect(bad!.registration).toBeNull();
    expect(bad!.typeIcao).toBeNull();
    expect(bad!.category).toBeNull();
    expect(good2!.registration).toBe('N456CD');
    expect(good2!.typeIcao).toBe('A320');
  });
});

describe('the "ground" sentinel governs every derived quantity', () => {
  // It used to gate altitude only, while verticalRateFpm read its identical
  // fallback chain ungated -- so a surface aircraft could report a climb rate.
  // Measured in the captured fixture: 74 rows carry alt_baro:"ground" and 2 of
  // them carry a rate, both adsr_icao rebroadcast rows. A recurring class, not
  // a one-off.

  it('nulls the vertical rate for an on-ground aircraft', () => {
    const parsed = parseAdsbLol({
      ac: [{ hex: 'a30b66', flight: 'TEST1 ', lat: 40, lon: -73, alt_baro: 'ground', alt_geom: 1250, geom_rate: -64 }],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.onGround).toBe(true);
    expect(parsed[0]!.altFt).toBeNull();
    // geom_rate came from the SAME GNSS source as the alt_geom the ground gate
    // just discarded; keeping one and dropping the other is the inconsistency.
    expect(parsed[0]!.verticalRateFpm).toBeNull();
  });

  it('leaves an airborne aircraft\'s rate alone', () => {
    const parsed = parseAdsbLol({
      ac: [{ hex: 'abc123', flight: 'TEST2 ', lat: 40, lon: -73, alt_baro: 18000, baro_rate: -1200 }],
    });
    expect(parsed[0]!.verticalRateFpm).toBe(-1200);
  });

  it('holds across the whole captured fixture: no on-ground row keeps a rate', () => {
    const all = parseAdsbLol(raw);
    const onGround = all.filter((a) => a.onGround);
    expect(onGround.length).toBeGreaterThan(50); // sanity on the check itself
    expect(onGround.filter((a) => a.verticalRateFpm !== null)).toEqual([]);
  });
});
