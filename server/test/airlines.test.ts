import { describe, it, expect } from 'vitest';
import { airlineName, searchAirlines } from '../src/airlines';

describe('searchAirlines', () => {
  // The case this exists for: a person sees a NetJets Citation overhead, knows
  // the word "NetJets" and nothing else, and the ignore list wants "EJA".
  it('finds a carrier by any part of its name, case-insensitively', () => {
    const codes = searchAirlines('NetJets').map((h) => h.code);
    expect(codes).toContain('EJA');
    expect(codes).toContain('NJE');
    expect(searchAirlines('netjets').map((h) => h.code)).toEqual(codes);
  });

  it('labels a hit with the name the wall would show, not the longest one on file', () => {
    // The generated table says "Netjets Aviation"; the wall says "NetJets".
    const eja = searchAirlines('netjets').find((h) => h.code === 'EJA');
    expect(eja?.name).toBe('NetJets');
  });

  it('finds an exact code too, and returns each code once', () => {
    const hits = searchAirlines('dal');
    expect(hits.map((h) => h.code)).toContain('DAL');
    expect(new Set(hits.map((h) => h.code)).size).toBe(hits.length);
  });

  it('answers nothing for a query too short to mean anything', () => {
    expect(searchAirlines('')).toEqual([]);
    expect(searchAirlines(' ')).toEqual([]);
    expect(searchAirlines('a')).toEqual([]);
  });

  it('caps the result list', () => {
    expect(searchAirlines('air', 5)).toHaveLength(5);
  });
});

describe('airlineName', () => {
  it('resolves a marketing carrier to its display name', () => {
    expect(airlineName('DL')).toBe('Delta');
    expect(airlineName('AA')).toBe('American');
    expect(airlineName('B6')).toBe('JetBlue');
  });

  it('is case-insensitive and trims', () => {
    expect(airlineName(' dl ')).toBe('Delta');
  });

  it('returns null only for a code no table anywhere knows', () => {
    // "ZZ" used to serve as the unknown code here. It is not unknown any more:
    // airlineName now also consults the firmware's mirrored table and a
    // ~6,400-carrier generated one, and between them very few real-looking
    // codes are left unclaimed. QQQ/Q0 are chosen precisely because all three
    // tables were checked for them when this was written -- if a future
    // regeneration claims one, this test will say so rather than quietly
    // stopping testing the null path.
    expect(airlineName('QQQ')).toBeNull();
    expect(airlineName('Q0')).toBeNull();
    expect(airlineName('')).toBeNull();
  });

  it('answers from the generated table for the long tail', () => {
    // The case this was all for: Arkia flies AIZ994 into JFK daily and the
    // card read "AIZ".
    expect(airlineName('AIZ')).not.toBeNull();
  });

  it('prefers the SHORT curated names over the generated long ones', () => {
    // Precedence is the whole design (see airlines.ts). The generated table
    // says "El Al - Israel Airlines" and "Swiss International Air Lines"; the
    // panel gives an airline 7-14 characters, so the curated forms must win.
    expect(airlineName('ELY')).toBe('El Al');
    expect(airlineName('SWR')).toBe('Swiss');
    expect(airlineName('DL')).toBe('Delta');
  });
});

describe('airlineName: carriers the wall actually sees', () => {
  it('knows Norse Atlantic UK, whose flights render blank without it', () => {
    // UBT70A (Z0 701, LGW->JFK) showed a route and no airline on the panel.
    // Neither table could name it: Z0 was missing here, and the device's
    // operating-carrier table carries NBT (Norse Atlantic Airways, Norway) but
    // not UBT, its UK subsidiary -- a different ICAO code for a different AOC.
    expect(airlineName('Z0')).toBe('Norse Atlantic');
  });
});
