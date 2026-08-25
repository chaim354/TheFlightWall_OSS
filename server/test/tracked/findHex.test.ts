import { describe, it, expect } from 'vitest';
import { flightNumberDigits, callsignDigits, matchByFlightNumber, SEARCH_RADIUS_NM } from '../../src/tracked/findHex';
import type { Aircraft } from '../../src/types';

const ac = (callsign: string, hex: string, over: Partial<Aircraft> = {}): Aircraft => ({
  hex, callsign, registration: null, typeIcao: null, lat: 41, lon: -73,
  altFt: 30000, groundspeedKt: 420, trackDeg: 270, verticalRateFpm: 0,
  onGround: false, category: null, distanceNm: null, bearingDeg: null, ...over,
});

describe('flightNumberDigits', () => {
  it('takes the trailing digit run, which is what a callsign shares with it', () => {
    expect(flightNumberDigits('AA3964')).toBe('3964');
    expect(flightNumberDigits('B6615')).toBe('615');
    expect(flightNumberDigits('9W2381')).toBe('2381');
  });

  it('strips leading zeros so DL0089 and DAL89 agree', () => {
    expect(flightNumberDigits('DL0089')).toBe('89');
  });

  it('returns null when there is no trailing number to match on', () => {
    expect(flightNumberDigits('BAW2LJ')).toBeNull();
    expect(flightNumberDigits('')).toBeNull();
  });
});

describe('matchByFlightNumber', () => {
  it('finds the operating aircraft by its flight-number digits', () => {
    // The case this exists for: AA3964 is flown as ENY3964 by Envoy, and
    // nothing in the pipeline can derive "ENY" from "AA". The digits can.
    const found = matchByFlightNumber(
      [ac('UAL231', 'aaa111'), ac('ENY3964', 'a23138'), ac('DAL55', 'bbb222')],
      'AA3964',
    );
    expect(found?.hex).toBe('a23138');
    expect(found?.callsign).toBe('ENY3964');
  });

  it('refuses to guess when two aircraft share the digits', () => {
    // Two carriers can both fly a 3964. A wrong hex is a wrong aircraft on the
    // panel, indistinguishable from a right one -- the same argument
    // matchSchedule makes when it sees duplicate rows and returns null.
    expect(matchByFlightNumber([ac('ENY3964', 'a23138'), ac('SWA3964', 'ccc333')], 'AA3964')).toBeNull();
  });

  it('ignores an aircraft on the ground', () => {
    // Still at the gate with the callsign already set is not the flight in the
    // air, and polling it would show a stationary aircraft as airborne.
    expect(matchByFlightNumber([ac('ENY3964', 'a23138', { onGround: true })], 'AA3964')).toBeNull();
  });

  it('ignores an empty or hexless record', () => {
    expect(matchByFlightNumber([ac('', 'a23138')], 'AA3964')).toBeNull();
    expect(matchByFlightNumber([ac('ENY3964', '')], 'AA3964')).toBeNull();
  });

  it('does not match a callsign that merely contains the digits', () => {
    // "39640" ends in 0, not 3964. Trailing-run equality, not substring.
    expect(matchByFlightNumber([ac('ENY39640', 'a23138')], 'AA3964')).toBeNull();
  });

  it('matches regardless of leading zeros on either side', () => {
    expect(matchByFlightNumber([ac('DAL89', 'ddd444')], 'DL0089')?.hex).toBe('ddd444');
  });

  it('returns null for a flight number with no trailing digits', () => {
    expect(matchByFlightNumber([ac('BAW2LJ', 'eee555')], 'BAW2LJ')).toBeNull();
  });

  it('searches a radius wide enough to absorb the tick interval', () => {
    // The estimate comes from the schedule and the tick is 300s, so the
    // aircraft can be several minutes from where the estimate puts it.
    expect(SEARCH_RADIUS_NM).toBeGreaterThanOrEqual(75);
  });
});

describe('the two sides are extracted differently, and must be', () => {
  it('strips a two-character IATA prefix even when it contains a digit', () => {
    // B6615 is JetBlue 615, broadcast as JBU615. Trailing-run on the flight
    // number would give "6615" and match nothing. Same for 9W, W6, U2, F9, G4.
    expect(flightNumberDigits('B6615')).toBe('615');
    expect(callsignDigits('JBU615')).toBe('615');
    expect(matchByFlightNumber([ac('JBU615', 'fff666')], 'B6615')?.hex).toBe('fff666');
  });

  it('takes the trailing run on the callsign side, where the prefix is letters', () => {
    expect(callsignDigits('ENY3964')).toBe('3964');
    expect(callsignDigits('BAW2LJ')).toBeNull();
  });
});
