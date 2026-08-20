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
