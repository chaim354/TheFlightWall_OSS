import { describe, it, expect } from 'vitest';
import { airlineName } from '../src/airlines';

describe('airlineName', () => {
  it('resolves a marketing carrier to its display name', () => {
    expect(airlineName('DL')).toBe('Delta');
    expect(airlineName('AA')).toBe('American');
    expect(airlineName('B6')).toBe('JetBlue');
  });

  it('is case-insensitive and trims', () => {
    expect(airlineName(' dl ')).toBe('Delta');
  });

  it('returns null for an unknown code so the caller can fall back', () => {
    expect(airlineName('ZZ')).toBeNull();
    expect(airlineName('')).toBeNull();
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
