import { describe, it, expect } from 'vitest';
import { callsignKey, candidateCarriers, matchSchedule } from '../src/join';
import type { ScheduleRow } from '../src/types';
import { getAirportCoord } from '../src/schedule/airports';

// Default row: CVG -> LGA. Both ends carry coordinates, because corridor
// deviation needs two points -- a row missing either end is rejected outright.
/**
 * Fixed 'now' for matchSchedule's temporal-plausibility filter. Rows below
 * default to schedArrEpoch: null, which that filter cannot evaluate and so
 * lets through -- these cases are about carrier and geometry, and the value
 * only has to be a real epoch. Time-specific behaviour is tested separately.
 */
const NOW = 1_787_000_000;

// Ask the table production asks, rather than restating its output -- see
// test/enrich.test.ts for why (F-SRV16-A).
const CVG = getAirportCoord('KCVG')!;
const LGA = getAirportCoord('KLGA')!;

const row = (over: Partial<ScheduleRow>): ScheduleRow => ({
  carrierIata: 'DL', number: '5075', callsign: null,
  origIata: 'CVG', destIata: 'LGA',
  origLat: CVG.lat, origLon: CVG.lon,
  destLat: LGA.lat, destLon: LGA.lon,
  schedArrEpoch: null,
  revArrEpoch: null,
  ...over,
});

describe('callsignKey', () => {
  it('splits an airline callsign into operator and trailing digits', () => {
    expect(callsignKey('EDV5075')).toEqual({ operator: 'EDV', number: '5075' });
    expect(callsignKey('AAL166')).toEqual({ operator: 'AAL', number: '166' });
  });

  it('trims, uppercases, and strips leading zeros from the number', () => {
    expect(callsignKey('  edv0075 ')).toEqual({ operator: 'EDV', number: '75' });
  });

  it('rejects callsigns that do not end in digits', () => {
    // British Airways transmits BAW2LJ for flight BA1228 -- no derivable
    // relationship to the number. 7% of airline callsigns are this shape.
    expect(callsignKey('BAW2LJ')).toBeNull();
    expect(callsignKey('AFR53X')).toBeNull();
    expect(callsignKey('IBE03ZD')).toBeNull();
  });

  it('rejects non-airline shapes', () => {
    expect(callsignKey('N172SP')).toBeNull();  // tail number
    expect(callsignKey('')).toBeNull();
    expect(callsignKey('AA')).toBeNull();
  });
});

describe('candidateCarriers', () => {
  it('maps a mainline operator to its own IATA code', () => {
    expect(candidateCarriers('DAL')).toEqual(['DL']);
    expect(candidateCarriers('JBU')).toEqual(['B6']);
  });

  it('maps a single-partner regional to that partner', () => {
    expect(candidateCarriers('EDV')).toEqual(['DL']);
  });

  it('maps a multi-partner regional to every partner it flies for', () => {
    // Measured live: RPA -> AA three times and RPA -> DL twice in one sample.
    const rpa = candidateCarriers('RPA')!;
    expect(rpa).toContain('AA');
    expect(rpa).toContain('DL');
    expect(rpa).toContain('UA');
  });

  it('returns null for an unknown operator, meaning "do not constrain"', () => {
    expect(candidateCarriers('ZZZ')).toBeNull();
  });
});

describe('matchSchedule', () => {
  const pos = { lat: 40.75, lon: -73.9 };  // over NYC

  it('prefers an exact operating-callsign match and skips disambiguation', () => {
    const rows = [
      row({ carrierIata: 'AA', number: '5075', callsign: 'ENY5075', destIata: 'DFW',
            destLat: 32.8968, destLon: -97.0380 }),
      row({ carrierIata: 'DL', number: '5075', callsign: 'EDV5075' }),
    ];
    const m = matchSchedule('EDV5075', pos.lat, pos.lon, rows, NOW);
    expect(m?.destIata).toBe('LGA');
  });

  it('falls back to number + carrier candidates when no callsign is present', () => {
    const rows = [
      row({ carrierIata: 'AA', number: '5075', destIata: 'DFW',
            destLat: 32.8968, destLon: -97.0380 }),
      row({ carrierIata: 'DL', number: '5075' }),
    ];
    // EDV flies only for DL, so the AA row is excluded before geometry.
    expect(matchSchedule('EDV5075', pos.lat, pos.lon, rows, NOW)?.destIata).toBe('LGA');
  });

  it('uses geometry to break a tie the carrier set cannot', () => {
    // RPA flies for both AA and DL, so both rows survive the carrier filter.
    const rows = [
      row({ carrierIata: 'AA', number: '4426', origIata: 'LAX', destIata: 'SFO',
            origLat: 33.9416, origLon: -118.4085, destLat: 37.6188, destLon: -122.375 }),
      row({ carrierIata: 'DL', number: '4426', origIata: 'BOS', destIata: 'LGA',
            origLat: 42.3656, origLon: -71.0096 }),
    ];
    expect(matchSchedule('RPA4426', pos.lat, pos.lon, rows, NOW)?.destIata).toBe('LGA');
  });

  it('returns null rather than guessing when ambiguity survives', () => {
    // Two rows, both allowed carriers, both equally plausible geometrically.
    const rows = [
      row({ carrierIata: 'AA', number: '4426', destIata: 'LGA' }),
      row({ carrierIata: 'DL', number: '4426', destIata: 'LGA' }),
    ];
    // Same destination coords => identical geometry => cannot choose.
    expect(matchSchedule('RPA4426', pos.lat, pos.lon, rows, NOW)).toBeNull();
  });

  it('returns null when a known operator narrows to zero, rather than falling back to an unnarrowed collision', () => {
    // Regression case: the real flight is EDV5075 (Delta, operated by
    // Endeavor). Its DL row is missing from this fetch -- a data gap, not a
    // table gap. The only row sharing this bare number is an unrelated
    // WN5075 (Southwest, MDW -> LGA) collision that happens to be landing
    // right where the aircraft is. EDV's table entry is ['DL'], so this WN
    // row narrows to zero and must be rejected outright -- an earlier
    // version fell back to the unnarrowed set here and geometry accepted
    // the WN row, because corridor excess cannot tell two NYC-bound routes
    // apart when every board this Worker watches is NYC-area.
    const rows = [
      row({
        carrierIata: 'WN', number: '5075', origIata: 'MDW',
        origLat: 41.7868, origLon: -87.7522,
      }),
    ];
    expect(matchSchedule('EDV5075', pos.lat, pos.lon, rows, NOW)).toBeNull();
  });

  it('declines the match entirely when the operator is absent from the table', () => {
    // CHANGED BEHAVIOUR, on live evidence. This used to fall through to
    // geometry alone. Measured over six unknown-operator aircraft, that
    // fallback was wrong every time it fired: JKR57, EJM290 and TCN719 each
    // locked onto an unrelated airline row sharing only a flight number,
    // while the three that were right (ITY608, EJA743, KAP5483) all came from
    // the exact-callsign path instead. Geometry cannot corroborate a lone
    // NYC-area row for an aircraft over NYC.
    const rows = [row({ carrierIata: 'XY', number: '2100' })];
    expect(matchSchedule('ZZZ2100', pos.lat, pos.lon, rows, NOW)).toBeNull();
  });

  it('still matches an unknown operator when the schedule ships its callsign', () => {
    // The other half, and why this is not simply a coverage cut: a foreign or
    // charter operator the table knows by callsign keeps its route. ITA
    // Airways (ITY), NetJets (EJA) and Cape Air (KAP) all matched this way.
    const rows = [row({ carrierIata: 'AZ', number: '608', callsign: 'ITY608', destIata: 'JFK' })];
    expect(matchSchedule('ITY608', pos.lat, pos.lon, rows, NOW)?.carrierIata).toBe('AZ');
  });

  it('rejects a row missing coordinates rather than trusting it unchecked', () => {
    const rows = [row({ origLat: null, origLon: null })];
    expect(matchSchedule('EDV5075', pos.lat, pos.lon, rows, NOW)).toBeNull();
  });

  it('returns null when no row matches the number', () => {
    expect(matchSchedule('DAL999', pos.lat, pos.lon, [row({})], NOW)).toBeNull();
  });

  it('returns null for an unjoinable callsign', () => {
    expect(matchSchedule('BAW2LJ', pos.lat, pos.lon, [row({})], NOW)).toBeNull();
  });

  it('rejects a match that is geometrically impossible', () => {
    // Aircraft over NYC, only candidate row is SFO-LAX. This is the real
    // SWA1304 case; blank beats a confident lie.
    const rows = [row({
      carrierIata: 'WN', number: '1304', origIata: 'SFO', destIata: 'LAX',
      origLat: 37.6188, origLon: -122.375, destLat: 33.9416, destLon: -118.4085,
    })];
    expect(matchSchedule('SWA1304', pos.lat, pos.lon, rows, NOW)).toBeNull();
  });
});

describe('matchSchedule: temporal plausibility', () => {
  // Every board this server watches is NYC-area, so a corridor into or out of
  // NYC passes near an aircraft over NYC almost by construction. Geometry can
  // therefore reject a route that is impossible (SFO-LAX overhead New York)
  // but not one that is merely for a different DAY. Time is what separates
  // those, and these are the cases that proved it was needed.

  const overJfk = { lat: 40.6398, lon: -73.7789 };
  const MIN = 60;
  const HOUR = 3600;

  /** JFK->ATL, ~660nm: the real shape of the row TCN719 wrongly matched. */
  const jfkAtl = (over: Partial<ScheduleRow> = {}): ScheduleRow =>
    row({
      carrierIata: 'B6', number: '719', origIata: 'JFK', destIata: 'ATL',
      origLat: 40.6398, origLon: -73.7789, destLat: 33.6367, destLon: -84.4281,
      ...over,
    });

  it('rejects a row scheduled to land long after this leg could possibly take', () => {
    // THE REGRESSION. Live, 2026-08-21: TCN719 over JFK matched
    // `B6 719 JFK->ATL` and rendered that route with an ~11h30 ETA. TCN is not
    // in CARRIER_CANDIDATES, so carrier narrowing was skipped; there was only
    // ONE candidate for number 719, so the tiebreak never ran; and the corridor
    // excess was ~0 because the aircraft was over JFK and the row starts at
    // JFK. Nothing in the old chain could see that the row was scheduled to
    // land at 03:46Z the NEXT day -- i.e. to depart some nine hours after this
    // aircraft was already airborne.
    const rows = [jfkAtl({ schedArrEpoch: NOW + 11 * HOUR })];
    expect(matchSchedule('JBU719', overJfk.lat, overJfk.lon, rows, NOW)).toBeNull();
  });

  it('keeps the same row when its arrival is consistent with the leg', () => {
    // The other half: the guard must not simply blank JFK->ATL. Two hours out
    // is an ordinary time for a ~660nm leg.
    const rows = [jfkAtl({ schedArrEpoch: NOW + 2 * HOUR })];
    const m = matchSchedule('JBU719', overJfk.lat, overJfk.lon, rows, NOW);
    expect(m?.destIata).toBe('ATL');
  });

  it('scales with distance, so a long-haul just off the runway is not rejected', () => {
    // A fixed cutoff would blank every long-haul departure. JFK->HND is
    // ~5,970nm and legitimately lands ~14h out; the bound has to be a function
    // of the distance still to run, not a constant.
    const rows = [row({
      carrierIata: 'DL', number: '9', origIata: 'JFK', destIata: 'HND',
      origLat: 40.6398, origLon: -73.7789, destLat: 35.5523, destLon: 139.7798,
      schedArrEpoch: NOW + 14 * HOUR,
    })];
    expect(matchSchedule('DAL9', overJfk.lat, overJfk.lon, rows, NOW)?.destIata).toBe('HND');
  });

  it('rejects a next-day row for an aircraft already near the destination', () => {
    // The commonest wrong-day shape: short distance left to run, arrival hours
    // away. 20nm from LGA cannot still be 5 hours from landing there.
    const nearLga = { lat: 40.95, lon: -73.95 };
    const rows = [row({ number: '4426', carrierIata: 'DL', schedArrEpoch: NOW + 5 * HOUR })];
    expect(matchSchedule('DAL4426', nearLga.lat, nearLga.lon, rows, NOW)).toBeNull();
  });

  it('does NOT punish a heavily delayed flight, because it tests the SCHEDULED time', () => {
    // DAL688 is the case this project has already been bitten by. A delay
    // pushes the REVISED arrival later while the scheduled one stays put or
    // slides into the past -- so testing the scheduled time cannot reject a
    // late-running flight, however late it is. Here the revised arrival is 9
    // hours out, far past the bound, and the row must still match.
    const rows = [jfkAtl({ schedArrEpoch: NOW - 3 * HOUR, revArrEpoch: NOW + 9 * HOUR })];
    const m = matchSchedule('JBU719', overJfk.lat, overJfk.lon, rows, NOW);
    expect(m?.destIata).toBe('ATL');
  });

  it('falls back to the revised time only when there is no scheduled one', () => {
    const rows = [jfkAtl({ schedArrEpoch: null, revArrEpoch: NOW + 11 * HOUR })];
    expect(matchSchedule('JBU719', overJfk.lat, overJfk.lon, rows, NOW)).toBeNull();
  });

  it('lets a row with no arrival time through rather than rejecting what it cannot judge', () => {
    // A provider that supplies routes without arrival times (the Port
    // Authority departures board does exactly this) must not lose every row to
    // a check it has no way to pass. The corridor check still applies.
    const rows = [jfkAtl({ schedArrEpoch: null, revArrEpoch: null })];
    expect(matchSchedule('JBU719', overJfk.lat, overJfk.lon, rows, NOW)?.destIata).toBe('ATL');
  });

  it('still applies to a known operator, which can also collide across days', () => {
    // Carrier narrowing is not a substitute: a DL callsign matching a DL row
    // for tomorrow survives narrowing untouched.
    const rows = [row({ carrierIata: 'DL', number: '5075', schedArrEpoch: NOW + 11 * HOUR })];
    expect(matchSchedule('EDV5075', overJfk.lat, overJfk.lon, rows, NOW)).toBeNull();
  });

  it('does not override an exact callsign match', () => {
    // The exact path is the strongest signal there is and returns before any
    // of this runs -- an operating callsign supplied by the provider is not
    // second-guessed on timing.
    const rows = [jfkAtl({ callsign: 'TCN719', schedArrEpoch: NOW + 11 * HOUR })];
    expect(matchSchedule('TCN719', overJfk.lat, overJfk.lon, rows, NOW)?.destIata).toBe('ATL');
  });

  it('uses the bound to break what geometry cannot, leaving the right row', () => {
    // Two same-number NYC rows, geometrically indistinguishable from overhead.
    // Previously this returned null (tiebreak refused both); the wrong-day row
    // is now removed first, so the real one wins outright.
    const rows = [
      row({ carrierIata: 'DL', number: '5075', schedArrEpoch: NOW + 11 * HOUR }),
      row({ carrierIata: 'DL', number: '5075', schedArrEpoch: NOW + 20 * MIN }),
    ];
    const m = matchSchedule('EDV5075', overJfk.lat, overJfk.lon, rows, NOW);
    expect(m?.schedArrEpoch).toBe(NOW + 20 * MIN);
  });
});
