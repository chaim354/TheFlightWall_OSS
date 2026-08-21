import { describe, it, expect } from 'vitest';
import { callsignKey, candidateCarriers, matchSchedule } from '../src/join';
import type { ScheduleRow } from '../src/types';

// Default row: CVG -> LGA. Both ends carry coordinates, because corridor
// deviation needs two points -- a row missing either end is rejected outright.
const row = (over: Partial<ScheduleRow>): ScheduleRow => ({
  carrierIata: 'DL', number: '5075', callsign: null,
  origIata: 'CVG', destIata: 'LGA',
  origLat: 39.0488, origLon: -84.6678,
  destLat: 40.7769, destLon: -73.8740,
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
    const m = matchSchedule('EDV5075', pos.lat, pos.lon, rows);
    expect(m?.destIata).toBe('LGA');
  });

  it('falls back to number + carrier candidates when no callsign is present', () => {
    const rows = [
      row({ carrierIata: 'AA', number: '5075', destIata: 'DFW',
            destLat: 32.8968, destLon: -97.0380 }),
      row({ carrierIata: 'DL', number: '5075' }),
    ];
    // EDV flies only for DL, so the AA row is excluded before geometry.
    expect(matchSchedule('EDV5075', pos.lat, pos.lon, rows)?.destIata).toBe('LGA');
  });

  it('uses geometry to break a tie the carrier set cannot', () => {
    // RPA flies for both AA and DL, so both rows survive the carrier filter.
    const rows = [
      row({ carrierIata: 'AA', number: '4426', origIata: 'LAX', destIata: 'SFO',
            origLat: 33.9416, origLon: -118.4085, destLat: 37.6188, destLon: -122.375 }),
      row({ carrierIata: 'DL', number: '4426', origIata: 'BOS', destIata: 'LGA',
            origLat: 42.3656, origLon: -71.0096 }),
    ];
    expect(matchSchedule('RPA4426', pos.lat, pos.lon, rows)?.destIata).toBe('LGA');
  });

  it('returns null rather than guessing when ambiguity survives', () => {
    // Two rows, both allowed carriers, both equally plausible geometrically.
    const rows = [
      row({ carrierIata: 'AA', number: '4426', destIata: 'LGA' }),
      row({ carrierIata: 'DL', number: '4426', destIata: 'LGA' }),
    ];
    // Same destination coords => identical geometry => cannot choose.
    expect(matchSchedule('RPA4426', pos.lat, pos.lon, rows)).toBeNull();
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
    expect(matchSchedule('EDV5075', pos.lat, pos.lon, rows)).toBeNull();
  });

  it('still falls through to geometry when the operator is entirely absent from the table', () => {
    // ZZZ has no entry in CARRIER_CANDIDATES at all, so candidateCarriers
    // returns null ("do not constrain") and the single row sharing this
    // number must be accepted on geometry alone. This is the fallback an
    // incomplete table is supposed to degrade into -- it must still work.
    const rows = [row({ carrierIata: 'XY', number: '2100' })];
    expect(matchSchedule('ZZZ2100', pos.lat, pos.lon, rows)?.carrierIata).toBe('XY');
  });

  it('rejects a row missing coordinates rather than trusting it unchecked', () => {
    const rows = [row({ origLat: null, origLon: null })];
    expect(matchSchedule('EDV5075', pos.lat, pos.lon, rows)).toBeNull();
  });

  it('returns null when no row matches the number', () => {
    expect(matchSchedule('DAL999', pos.lat, pos.lon, [row({})])).toBeNull();
  });

  it('returns null for an unjoinable callsign', () => {
    expect(matchSchedule('BAW2LJ', pos.lat, pos.lon, [row({})])).toBeNull();
  });

  it('rejects a match that is geometrically impossible', () => {
    // Aircraft over NYC, only candidate row is SFO-LAX. This is the real
    // SWA1304 case; blank beats a confident lie.
    const rows = [row({
      carrierIata: 'WN', number: '1304', origIata: 'SFO', destIata: 'LAX',
      origLat: 37.6188, origLon: -122.375, destLat: 33.9416, destLon: -118.4085,
    })];
    expect(matchSchedule('SWA1304', pos.lat, pos.lon, rows)).toBeNull();
  });
});
