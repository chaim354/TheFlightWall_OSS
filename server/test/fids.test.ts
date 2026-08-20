import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFids } from '../src/schedule/aerodatabox';

// Live fixture: KJFK board, 4-hour window around 2026-08-20T21:30Z,
// withLeg=true&direction=Both, 261 rows (131 arrivals + 130 departures).
// See fixtures/README.md for how it was captured.
const raw = JSON.parse(readFileSync(new URL('../fixtures/fids-kjfk.json', import.meta.url), 'utf8'));

describe('parseFids', () => {
  const rows = parseFids(raw, 'KJFK');

  it('produces rows with a number and a carrier for nearly every raw row', () => {
    // 261 raw rows; a handful may be skipped for having no derivable flight
    // number, but the overwhelming majority must parse.
    expect(rows.length).toBeGreaterThan(250);
    for (const r of rows) {
      expect(r.number).toMatch(/^\d+$/);
      expect(r.carrierIata.length).toBeGreaterThan(0);
    }
  });

  it('parses "DL 4984" -- stripping the space -- into carrier DL, number 4984', () => {
    // A real row in the fixture: an arrival, KIND (Indianapolis) -> KJFK,
    // with no callSign. Named explicitly because this exact number/space
    // combination is what the task asked this test to cover.
    const r = rows.find((row) => row.carrierIata === 'DL' && row.number === '4984');
    expect(r).toBeDefined();
    expect(r!.origIata).toBe('IND');
    expect(r!.destIata).toBe('JFK');
    expect(r!.callsign).toBeNull();
  });

  it('strips leading zeros from the flight number', () => {
    // The captured fixture happens to contain no leading-zero flight numbers
    // (verified: no `number` field matches / 0\d/), so this exercises the
    // path directly with a constructed row rather than relying on incidental
    // data that may not always be there.
    const synthetic = parseFids(
      {
        departures: [
          {
            number: 'DL 0075',
            airline: { iata: 'DL' },
            departure: { scheduledTime: { utc: '2026-08-20 10:00Z' } },
            arrival: {
              airport: { icao: 'KCVG', iata: 'CVG' },
              scheduledTime: { utc: '2026-08-20 12:00Z' },
            },
          },
        ],
      },
      'KJFK',
    );
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]!.number).toBe('75');
  });

  it('surfaces callSign when the provider supplies one', () => {
    // Real row: "JL 4" (Japan Airlines) arrives from Tokyo Haneda with
    // callSign "JAL4" -- the operating callsign, distinct from the IATA
    // carrier prefix "JL".
    const r = rows.find((row) => row.carrierIata === 'JL' && row.number === '4');
    expect(r?.callsign).toBe('JAL4');
  });

  it('leaves callsign null when the provider does not supply one', () => {
    const r = rows.find((row) => row.carrierIata === 'DL' && row.number === '4984');
    expect(r?.callsign).toBeNull();
  });

  it('records whether the provider supplied an operating callsign -- both states genuinely occur', () => {
    for (const r of rows) {
      expect(r.callsign === null || typeof r.callsign === 'string').toBe(true);
    }
    // Not dead code either way: the captured fixture has both a callsigned
    // majority-ish share and a substantial callsign-less share (measured
    // ~44% overall; see fixtures/README.md), so both branches are live.
    expect(rows.some((r) => r.callsign !== null)).toBe(true);
    expect(rows.some((r) => r.callsign === null)).toBe(true);
  });

  it('never throws on a malformed top-level payload', () => {
    expect(parseFids({}, 'KJFK')).toEqual([]);
    expect(parseFids({ arrivals: null }, 'KJFK')).toEqual([]);
    expect(parseFids({ departures: null }, 'KJFK')).toEqual([]);
    expect(parseFids(null, 'KJFK')).toEqual([]);
    expect(parseFids('garbage', 'KJFK')).toEqual([]);
    expect(parseFids(undefined, 'KJFK')).toEqual([]);
  });

  it('never throws on garbage entries inside an otherwise-valid array', () => {
    expect(() =>
      parseFids(
        {
          arrivals: [
            null,
            42,
            'x',
            {},
            { number: 123 }, // number arrives as a number, not a string
            { number: 'DL 5', airline: { iata: 5 } }, // airline.iata arrives as a number
            { number: 'NOTAFLIGHTNUMBER' }, // no trailing digit run at all
          ],
        },
        'KJFK',
      ),
    ).not.toThrow();
  });

  it('returns nothing for a board it has no coordinates for', () => {
    const out = parseFids({ arrivals: [{ number: 'DL 1', airline: { iata: 'DL' } }] }, 'KXXX');
    expect(out).toEqual([]);
  });

  it('skips a row with no derivable flight number', () => {
    const out = parseFids({ arrivals: [{ number: 'CHARTER', airline: { iata: 'DL' } }] }, 'KJFK');
    expect(out).toHaveLength(0);
  });

  it('falls back to slicing the number for the carrier when airline.iata is absent', () => {
    const out = parseFids(
      {
        departures: [
          {
            number: 'XY123',
            arrival: { airport: { icao: 'KCVG', iata: 'CVG' } },
          },
        ],
      },
      'KJFK',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.carrierIata).toBe('XY');
    expect(out[0]!.number).toBe('123');
  });

  it('handles a far airport object with no icao/iata -- a real gap seen in the fixture -- without throwing', () => {
    // DL 791, TK 11 and AA 4463 in the captured fixture each carry a far
    // `airport` object with only a `name` field -- no icao, no iata. This is
    // AeroDataBox's own data gap, confirmed in the live capture, not a
    // hypothetical. AA 4463 is a departures-list row, so its missing far end
    // lands on destIata/destLat/destLon (KJFK -> unknown); DL 791 and TK 11
    // are arrivals-list rows, where the same gap would land on the orig*
    // fields instead -- see the direction tests below for which field means
    // what.
    const r = rows.find((row) => row.carrierIata === 'AA' && row.number === '4463');
    expect(r).toBeDefined();
    expect(r!.origIata).toBe('JFK'); // the known end: this board, untouched by the gap
    expect(r!.destIata).toBeNull();
    expect(r!.destLat).toBeNull();
    expect(r!.destLon).toBeNull();
    // The row itself still exists and is still usable for an exact-callsign
    // match or for display of what IS known (carrier, number) -- a missing
    // far end drops that one end, not the whole row.
    expect(r!.carrierIata).toBe('AA');
  });

  it('resolves far-end coordinates from the bundled table for a real arrival row', () => {
    // "JL 4" arrives from RJTT (Tokyo Haneda). FAR_AIRPORT_COORDS carries
    // RJTT at {35.5523, 139.78}, fetched live from AeroDataBox's own
    // Airport-by-ICAO endpoint (see airports.ts).
    const r = rows.find((row) => row.carrierIata === 'JL' && row.number === '4');
    expect(r).toBeDefined();
    expect(r!.origIata).toBe('HND');
    expect(r!.origLat).toBeCloseTo(35.5523, 3);
    expect(r!.origLon).toBeCloseTo(139.78, 3);
    // The near end is always the board airport, from BOARD_AIRPORTS.
    expect(r!.destIata).toBe('JFK');
    expect(r!.destLat).toBeCloseTo(40.6413, 3);
  });

  it('leaves far-end coordinates null for an airport not in the bundled table, without throwing', () => {
    const out = parseFids(
      {
        arrivals: [
          {
            number: 'ZZ 9999',
            airline: { iata: 'ZZ' },
            departure: {
              airport: { icao: 'ZZZZ', iata: 'ZZZ' }, // not a real airport, not in the table
              scheduledTime: { utc: '2026-08-20 10:00Z' },
            },
            arrival: { scheduledTime: { utc: '2026-08-20 12:00Z' } },
          },
        ],
      },
      'KJFK',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.origIata).toBe('ZZZ'); // display code still known
    expect(out[0]!.origLat).toBeNull(); // but coordinates are not
    expect(out[0]!.origLon).toBeNull();
  });
});

describe('puts the board airport on the correct end for each direction', () => {
  it('arrival row: far end is the origin, the board is the destination', () => {
    const arr = parseFids(
      {
        arrivals: [
          {
            number: 'DL 5075',
            airline: { iata: 'DL' },
            departure: {
              airport: { icao: 'KCVG', iata: 'CVG' },
              scheduledTime: { utc: '2026-08-20 10:00Z' },
            },
            arrival: { scheduledTime: { utc: '2026-08-20 12:00Z' } },
          },
        ],
      },
      'KJFK',
    );
    expect(arr).toHaveLength(1);
    expect(arr[0]!.origIata).toBe('CVG');
    expect(arr[0]!.destIata).toBe('JFK');
    expect(arr[0]!.origLat).toBeCloseTo(39.0488, 3); // CVG, from FAR_AIRPORT_COORDS
    expect(arr[0]!.origLon).toBeCloseTo(-84.6678, 3);
    expect(arr[0]!.destLat).toBeCloseTo(40.6413, 3); // JFK, from BOARD_AIRPORTS
    expect(arr[0]!.destLon).toBeCloseTo(-73.7781, 3);
    expect(arr[0]!.schedArrEpoch).toBe(Math.floor(Date.parse('2026-08-20 12:00Z') / 1000));
  });

  it('departure row: the board is the origin, far end is the destination', () => {
    const dep = parseFids(
      {
        departures: [
          {
            number: 'DL 5076',
            airline: { iata: 'DL' },
            departure: { scheduledTime: { utc: '2026-08-20 10:00Z' } },
            arrival: {
              airport: { icao: 'KCVG', iata: 'CVG' },
              scheduledTime: { utc: '2026-08-20 12:00Z' },
            },
          },
        ],
      },
      'KJFK',
    );
    expect(dep).toHaveLength(1);
    expect(dep[0]!.origIata).toBe('JFK');
    expect(dep[0]!.destIata).toBe('CVG');
    expect(dep[0]!.origLat).toBeCloseTo(40.6413, 3); // JFK, from BOARD_AIRPORTS
    expect(dep[0]!.destLat).toBeCloseTo(39.0488, 3); // CVG, from FAR_AIRPORT_COORDS
    // Same JSON shape, opposite direction: schedArrEpoch is still the
    // arrival time -- at the far end this time, not at the board.
    expect(dep[0]!.schedArrEpoch).toBe(Math.floor(Date.parse('2026-08-20 12:00Z') / 1000));
  });
});
