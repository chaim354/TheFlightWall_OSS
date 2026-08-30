import { describe, it, expect } from 'vitest';
import { carrierIataOf, normaliseCarrierCode, operatorIcaoOf } from '../src/carrierCode';

describe('normaliseCarrierCode', () => {
  it('accepts both vocabularies, uppercased and stripped', () => {
    expect(normaliseCarrierCode(' aiz ')).toBe('AIZ'); // ICAO, what the wall shows
    expect(normaliseCarrierCode('iz')).toBe('IZ');     // IATA, what a boarding pass shows
    expect(normaliseCarrierCode('9w')).toBe('9W');     // a real mixed-alnum carrier
  });

  it('rejects anything that is not a carrier code', () => {
    // "99" in particular: alphanumeric and the right length, but no carrier
    // code is all digits, and accepting it would let a fragment of a flight
    // number become a table key.
    for (const v of ['', '  ', undefined, null, 'A', 'ABCD', '99', 'A-Z']) {
      expect(normaliseCarrierCode(v)).toBeNull();
    }
  });
});

describe('operatorIcaoOf', () => {
  it('reads the prefix the device displays', () => {
    expect(operatorIcaoOf('AIZ994')).toBe('AIZ');
    expect(operatorIcaoOf('baw181')).toBe('BAW');
  });

  it('accepts an alphanumeric callsign whose fourth character is a digit', () => {
    // BAW2LJ is a real shape. It looks unparseable at a glance and is not:
    // the rule is only about position four.
    expect(operatorIcaoOf('BAW2LJ')).toBe('BAW');
  });

  it('refuses a tail number, exactly as the firmware parseAirlineIcao does', () => {
    // Without the fourth-character rule "N172SP" reads as carrier "N17", and
    // the page would offer to name a code that is not a carrier and that
    // nobody ever saw on the wall.
    expect(operatorIcaoOf('N172SP')).toBeNull();
    expect(operatorIcaoOf('G-STBA')).toBeNull();
    expect(operatorIcaoOf('AI')).toBeNull();
    expect(operatorIcaoOf(null)).toBeNull();
  });
});

describe('carrierIataOf', () => {
  it('takes the first two characters', () => {
    expect(carrierIataOf('BA181')).toBe('BA');
    expect(carrierIataOf('IZ994')).toBe('IZ');
    expect(carrierIataOf('9W2381')).toBe('9W');
  });

  it('REGRESSION: handles carriers whose IATA code ends in a digit', () => {
    // The bug this file was extracted to fix. tracked/serve.ts found the
    // prefix by stripping the trailing run of digits, so for Z0701 the run ate
    // the "0" of the carrier code, leaving "Z" -- too short, rejected, null.
    // Both of these carriers are in the curated name table, so their pinned
    // cards rendered with no airline while the name sat right there.
    expect(carrierIataOf('Z0701')).toBe('Z0');  // Norse Atlantic
    expect(carrierIataOf('U2884')).toBe('U2');  // easyJet
  });

  it('is null when the remainder is not a flight number', () => {
    expect(carrierIataOf('BAW2LJ')).toBeNull(); // a callsign, not a number
    expect(carrierIataOf('BA')).toBeNull();     // no number at all
    expect(carrierIataOf('99123')).toBeNull();  // "99" is not a carrier
    expect(carrierIataOf(null)).toBeNull();
  });
});
