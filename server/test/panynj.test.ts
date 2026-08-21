import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decompressFromEncodedURIComponent } from 'lz-string';
import { parseBoard, fetchBoard, QUERIES, isPanynjAirport } from '../src/schedule/panynj';

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

const jfkArrivals = load('panynj-jfk-arrivals.json');
const lgaDepartures = load('panynj-lga-departures.json');
const captured = load('panynj-queries.json') as {
  departures: { query: string; operationName: string };
  arrivals: { query: string; operationName: string };
};

describe('query text matches what the Port Authority site sends', () => {
  // The endpoint matches query TEXT against an allowlist -- a query differing
  // only in whitespace is rejected with a 400 and an HTML error page
  // (verified live). These two assertions are the early-warning system: if
  // the Port Authority redeploys with a reformatted query and the captured
  // fixture is refreshed, these fail loudly here instead of the fetch
  // silently 400ing in production.

  it('departures query is byte-for-byte the captured one', () => {
    expect(QUERIES.departures).toBe(captured.departures.query);
  });

  it('arrivals query is byte-for-byte the captured one', () => {
    expect(QUERIES.arrivals).toBe(captured.arrivals.query);
  });

  it('the arrivals query really does differ from departures by more than names', () => {
    // Guards a plausible mistake: deriving one query from the other by
    // string substitution. The arrivals payload carries an extra
    // `isInternationalFlight` field, and a substitution-built query would
    // omit it and be rejected.
    expect(captured.arrivals.query).toContain('isInternationalFlight');
    expect(captured.departures.query).not.toContain('isInternationalFlight');
  });
});

describe('parseBoard: arrivals', () => {
  const rows = parseBoard(jfkArrivals, 'JFK', 'arrival');

  it('parses every non-cancelled row in the fixture', () => {
    const raw = (jfkArrivals as { data: { getArrivingFlights: { data: Record<string, unknown>[] } } })
      .data.getArrivingFlights.data;
    const cancelled = raw.filter((r) => String(r.status).toLowerCase() === 'cancelled').length;
    expect(rows.length).toBe(raw.length - cancelled);
    expect(rows.length).toBeGreaterThan(400);
  });

  it('puts the board airport on the destination side and the far end on the origin side', () => {
    const r = rows.find((x) => x.carrierIata === 'CX' && x.number === '7822');
    expect(r).toBeDefined();
    expect(r!.origIata).toBe('SCL');
    expect(r!.destIata).toBe('JFK');
    // Both ends need coordinates -- matchSchedule's corridor check needs two points.
    expect(r!.destLat).toBeCloseTo(40.6394, 2);
    expect(r!.origLat).toBeCloseTo(-33.39, 1);
  });

  it('carries a scheduled arrival time, converted from New York local to UTC', () => {
    const r = rows.find((x) => x.carrierIata === 'CX' && x.number === '7822')!;
    // 2026-08-21 09:40 AM EDT (UTC-4) == 13:40Z
    expect(r.schedArrEpoch).toBe(Math.floor(Date.UTC(2026, 7, 21, 13, 40) / 1000));
  });

  it('resolves the revised time even though dateRevised is always null', () => {
    const r = rows.find((x) => x.carrierIata === 'CX' && x.number === '7822')!;
    // timeRevised "09:12 AM" EDT == 13:12Z, i.e. 28 minutes early.
    expect(r.revArrEpoch).toBe(Math.floor(Date.UTC(2026, 7, 21, 13, 12) / 1000));
  });

  it('supplies a revised time far more often than AeroDataBox does', () => {
    // The reason this source is worth having for arrivals: measured 96% here
    // against AeroDataBox's 39%. Asserted as a floor, not the exact figure,
    // so refreshing the fixture does not require editing a magic number.
    const withRevised = rows.filter((r) => r.revArrEpoch !== null).length;
    expect(withRevised / rows.length).toBeGreaterThan(0.8);
  });

  it('never invents an operating callsign', () => {
    // These boards publish the marketing carrier only. A fabricated callsign
    // would feed join.ts's exact-match path, which trusts it completely.
    expect(rows.every((r) => r.callsign === null)).toBe(true);
  });
});

describe('parseBoard: departures', () => {
  const rows = parseBoard(lgaDepartures, 'LGA', 'departure');

  it('puts the board airport on the origin side', () => {
    const r = rows.find((x) => x.carrierIata === 'AA' && x.number === '4401');
    expect(r).toBeDefined();
    expect(r!.origIata).toBe('LGA');
    expect(r!.destIata).toBe('ILM');
  });

  it('leaves arrival times null rather than reusing the departure time', () => {
    // The departures query returns no far-end arrival time at all. Treating
    // the departure time as an arrival would put a JFK->LAX flight on the
    // ground six hours early -- the confident-wrong answer this project
    // blanks instead. enrich.ts falls through to the physics ETA.
    expect(rows.every((r) => r.schedArrEpoch === null && r.revArrEpoch === null)).toBe(true);
  });
});

describe('parseBoard: the carrier/number split that cannot go wrong here', () => {
  it('never fuses the carrier code onto the flight number', () => {
    // The bug that corrupted 15% of the AeroDataBox table ("B6 1184" ->
    // carrier B6, number 61184) is structurally impossible on this source,
    // because carrier and number arrive in separate fields. The property that
    // actually proves it is number-for-number equality with the raw field --
    // NOT "no B6 number starts with 6", which would be wrong: B6 6184 is a
    // real JetBlue flight, and a digit-ending carrier makes a legitimate
    // number indistinguishable from a corrupted one by inspection alone.
    const raw = (jfkArrivals as { data: { getArrivingFlights: { data: Record<string, unknown>[] } } })
      .data.getArrivingFlights.data.filter((r) => String(r.status).toLowerCase() !== 'cancelled');
    const rows = parseBoard(jfkArrivals, 'JFK', 'arrival');
    expect(rows.length).toBe(raw.length);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.number).toBe(String(raw[i]!.flightNumber));
      expect(rows[i]!.carrierIata).toBe(String(raw[i]!.airlineCode).toUpperCase());
    }
    // And the hazardous carriers really are present, so this is not vacuous.
    expect(rows.some((r) => /\d$/.test(r.carrierIata))).toBe(true);
  });

  it('strips leading zeros so the number matches callsignKey normalisation', () => {
    const out = parseBoard(
      { data: { getArrivingFlights: { data: [row({ flightNumber: '0032', airlineCode: 'AA' })] } } },
      'JFK',
      'arrival',
    );
    expect(out[0]!.number).toBe('32');
  });
});

describe('parseBoard: degrades instead of throwing', () => {
  const call = (body: unknown): ScheduleRowLike[] =>
    parseBoard(body, 'JFK', 'arrival') as ScheduleRowLike[];
  type ScheduleRowLike = { number: string };

  it('returns empty for junk payloads instead of throwing', () => {
    for (const junk of [null, undefined, 42, 'nope', {}, { data: null }, { data: { getArrivingFlights: {} } }]) {
      expect(() => call(junk)).not.toThrow();
      expect(call(junk)).toEqual([]);
    }
  });

  it('skips a wrong-typed row without losing the good rows around it', () => {
    const out = call({
      data: {
        getArrivingFlights: {
          data: [
            row({ flightNumber: 111 }),
            null,
            'not a row',
            { flightNumber: {}, airlineCode: 'AA' },
            row({ flightNumber: 222, airlineCode: '' }),
            row({ flightNumber: 333 }),
          ],
        },
      },
    });
    expect(out.map((r) => r.number)).toEqual(['111', '333']);
  });

  it('drops cancelled flights, which cannot be the aircraft overhead', () => {
    const out = call({
      data: {
        getArrivingFlights: {
          data: [row({ flightNumber: 1, status: 'Cancelled' }), row({ flightNumber: 2, status: 'En Route' })],
        },
      },
    });
    expect(out.map((r) => r.number)).toEqual(['2']);
  });

  it('keeps a row whose far airport is not in the coordinate table, without coordinates', () => {
    // A route we can show but cannot corridor-check is still worth showing;
    // join.ts already treats a null coordinate as "cannot check this leg".
    const out = parseBoard(
      { data: { getArrivingFlights: { data: [row({ flightNumber: 9, originAirportCode: 'ZZZ' })] } } },
      'JFK',
      'arrival',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.origIata).toBe('ZZZ');
    expect(out[0]!.origLat).toBeNull();
    expect(out[0]!.destIata).toBe('JFK');
  });
});

describe('revised time across midnight', () => {
  const revisedFor = (timeScheduled: string, timeRevised: string, dateScheduled = '2026-08-21') =>
    parseBoard(
      {
        data: {
          getArrivingFlights: {
            data: [row({ flightNumber: 1, dateScheduled, timeScheduled, timeRevised })],
          },
        },
      },
      'JFK',
      'arrival',
    )[0]!;

  it('treats a revision past midnight as a delay, not a 23-hour jump backwards', () => {
    const r = revisedFor('11:50 PM', '12:20 AM');
    // 2026-08-21 23:50 EDT = 03:50Z on the 22nd; revised 00:20 EDT on the
    // 22nd = 04:20Z -- i.e. 30 minutes LATE.
    expect(r.revArrEpoch! - r.schedArrEpoch!).toBe(30 * 60);
  });

  it('treats an early arrival back across midnight as early, not a day late', () => {
    const r = revisedFor('12:10 AM', '11:45 PM');
    expect(r.revArrEpoch! - r.schedArrEpoch!).toBe(-25 * 60);
  });

  it('handles an ordinary same-day delay unchanged', () => {
    const r = revisedFor('10:30 AM', '12:00 PM');
    expect(r.revArrEpoch! - r.schedArrEpoch!).toBe(90 * 60);
  });
});

describe('New York local time conversion', () => {
  it('uses EDT in summer', () => {
    const r = parseBoard(
      { data: { getArrivingFlights: { data: [row({ flightNumber: 1, dateScheduled: '2026-07-04', timeScheduled: '12:00 PM' })] } } },
      'JFK',
      'arrival',
    )[0]!;
    expect(r.schedArrEpoch).toBe(Math.floor(Date.UTC(2026, 6, 4, 16, 0) / 1000)); // UTC-4
  });

  it('uses EST in winter -- a fixed offset would be an hour out for half the year', () => {
    const r = parseBoard(
      { data: { getArrivingFlights: { data: [row({ flightNumber: 1, dateScheduled: '2026-01-15', timeScheduled: '12:00 PM' })] } } },
      'JFK',
      'arrival',
    )[0]!;
    expect(r.schedArrEpoch).toBe(Math.floor(Date.UTC(2026, 0, 15, 17, 0) / 1000)); // UTC-5
  });

  it('handles midnight, which formats as hour 24 under hour12:false', () => {
    const r = parseBoard(
      { data: { getArrivingFlights: { data: [row({ flightNumber: 1, timeScheduled: '12:00 AM' })] } } },
      'JFK',
      'arrival',
    )[0]!;
    expect(r.schedArrEpoch).toBe(Math.floor(Date.UTC(2026, 7, 21, 4, 0) / 1000));
  });
});

describe('fetchBoard', () => {
  const okResponse = (body: unknown, next?: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      const b = structuredClone(body) as { data: Record<string, { paging: { next: string | null } }> };
      const field = Object.keys(b.data)[0]!;
      b.data[field]!.paging = { next: next ?? null };
      return b;
    },
  });

  it('sends an lz-string compressed text/plain body carrying the allowlisted query', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return okResponse(jfkArrivals);
    }) as unknown as typeof fetch;

    await fetchBoard('JFK', 'arrival', Date.UTC(2026, 7, 21, 15, 0), { fetchImpl: fake, pageDelayMs: 0 });

    expect(seen).not.toBeNull();
    const { init } = seen!;
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/plain');
    const payload = JSON.parse(decompressFromEncodedURIComponent(init.body as string)!);
    expect(payload.query).toBe(QUERIES.arrivals);
    expect(payload.operationName).toBe('GetArrivingFlights');
    expect(payload.variables.arrivalAirport).toBe('JFK');
    // Window is centred on now, in NY local time: 15:00Z == 11:00 EDT.
    expect(payload.variables.arrivalDateTime).toBe('2026-08-21T08:00/2026-08-21T14:00');
    // Empty filters mean "everything" -- the UI marks these required, the API does not.
    expect(payload.variables.originAirport).toBe('');
    expect(payload.variables.carrierCode).toBe('');
  });

  it('follows pagination and concatenates pages', async () => {
    let calls = 0;
    const fake = (async (_url: string, init: RequestInit) => {
      calls++;
      const after = JSON.parse(decompressFromEncodedURIComponent(init.body as string)!).variables.after;
      if (calls === 1) {
        expect(after).toBe('');
        return okResponse(jfkArrivals, 'CURSOR-2');
      }
      expect(after).toBe('CURSOR-2');
      return okResponse(jfkArrivals);
    }) as unknown as typeof fetch;

    const rows = await fetchBoard('JFK', 'arrival', Date.now(), { fetchImpl: fake, pageDelayMs: 0 });
    const single = parseBoard(jfkArrivals, 'JFK', 'arrival');
    expect(calls).toBe(2);
    expect(rows.length).toBe(single.length * 2);
  });

  it('throws on a non-200 so the caller can fall back to the other source', async () => {
    const fake = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchBoard('JFK', 'arrival', Date.now(), { fetchImpl: fake, pageDelayMs: 0 })).rejects.toThrow(/403/);
  });

  it('throws on a GraphQL-level error rather than returning an empty board', async () => {
    // An empty board is indistinguishable downstream from "no flights", which
    // would silently blank every route this airport contributes.
    const fake = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'bad' }] }),
    })) as unknown as typeof fetch;
    await expect(fetchBoard('JFK', 'arrival', Date.now(), { fetchImpl: fake, pageDelayMs: 0 })).rejects.toThrow(/graphql/);
  });

  it('stops at the page cap instead of looping forever on a non-terminating cursor', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return okResponse(jfkArrivals, 'ALWAYS-MORE');
    }) as unknown as typeof fetch;
    await fetchBoard('JFK', 'arrival', Date.now(), { fetchImpl: fake, pageDelayMs: 0 });
    expect(calls).toBe(4);
  });
});

describe('isPanynjAirport', () => {
  it('covers the three Port Authority airports and excludes Massport BOS', () => {
    for (const a of ['JFK', 'LGA', 'EWR', 'jfk']) expect(isPanynjAirport(a)).toBe(true);
    // BOS is Massport's -- it has no board here and must stay on AeroDataBox.
    for (const a of ['BOS', 'PHL', 'HPN', '']) expect(isPanynjAirport(a)).toBe(false);
  });
});

/** A minimal arrivals row with the shape the live payload uses. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dateScheduled: '2026-08-21',
    timeScheduled: '09:40 AM',
    dateRevised: null,
    timeRevised: null,
    originName: 'Somewhere',
    originAirportCode: 'ORD',
    airlineCode: 'AA',
    airlineName: 'American Airlines',
    flightNumber: 1,
    terminal: '4',
    gate: null,
    status: 'En Route',
    isInternationalFlight: false,
    __typename: 'ArrivingFlightInstance',
    ...over,
  };
}
