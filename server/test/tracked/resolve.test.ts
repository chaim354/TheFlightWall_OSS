import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseByNumber, resolveFlight } from '../../src/tracked/resolve';

const payload = [
  {
    number: 'BA 181',
    callSign: 'BAW181',
    status: 'Expected',
    aircraft: { reg: 'G-STBA', modeS: '4008F3', model: 'Boeing 777' },
    departure: {
      airport: { iata: 'JFK', location: { lat: 40.6413, lon: -73.7781 } },
      scheduledTime: { utc: '2026-09-14 18:00Z' },
    },
    arrival: {
      airport: { iata: 'LHR', location: { lat: 51.47, lon: -0.4543 } },
      scheduledTime: { utc: '2026-09-15 01:00Z' },
    },
  },
];

describe('parseByNumber', () => {
  it('extracts the hex, registration, route and times', () => {
    const r = parseByNumber(payload, '2026-09-14');
    expect(r).not.toBeNull();
    // Lowercased: OpenSky's icao24 is lowercase hex and comparisons elsewhere
    // assume it.
    expect(r!.icao24).toBe('4008f3');
    expect(r!.callsign).toBe('BAW181');
    expect(r!.reg).toBe('G-STBA');
    expect(r!.aircraftModel).toBe('Boeing 777');
    expect(r!.origIata).toBe('JFK');
    expect(r!.destIata).toBe('LHR');
    expect(r!.orig).toEqual({ lat: 40.6413, lon: -73.7781 });
    expect(r!.schedDepEpoch).toBe(Math.floor(Date.parse('2026-09-14T18:00:00Z') / 1000));
    expect(r!.schedArrEpoch).toBe(Math.floor(Date.parse('2026-09-15T01:00:00Z') / 1000));
  });

  it('accepts a bare object as well as an array', () => {
    expect(parseByNumber(payload[0]!, '2026-09-14')!.icao24).toBe('4008f3');
  });

  it('returns null for an empty array (flight not operating that date)', () => {
    expect(parseByNumber([], '2026-09-14')).toBeNull();
  });

  it('returns a row with a null hex rather than null, when modeS is missing', () => {
    // "Resolved but no hex" is a DIFFERENT outcome from "no such flight", and
    // the caller reports them with different reasons. Collapsing them would
    // hide the spec's flagged risk that the by-number endpoint may not carry
    // modeS at all.
    const noHex = [{ ...payload[0]!, aircraft: { reg: 'G-STBA', model: 'B777' } }];
    const r = parseByNumber(noHex, '2026-09-14');
    expect(r).not.toBeNull();
    expect(r!.icao24).toBeNull();
    expect(r!.reg).toBe('G-STBA');
  });

  it('tolerates missing coordinates without throwing', () => {
    const noCoord = [{ ...payload[0]!, departure: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-09-14 18:00Z' } } }];
    const r = parseByNumber(noCoord, '2026-09-14');
    expect(r!.orig).toBeNull();
    expect(r!.origIata).toBe('JFK');
  });

  it('extracts icao24 from the real captured AeroDataBox response', () => {
    // A parser that only ever sees hand-written fixtures is not verified
    // against the real payload shape. server/fixtures/aerodatabox-bynumber.json
    // was captured live against BA181 (LHR->JFK that day; see Task 1's
    // measurements doc) and is ground truth for the payload shape, including
    // aircraft.modeS nesting and the departure/arrival.airport.location path.
    const real = JSON.parse(
      readFileSync(new URL('../../fixtures/aerodatabox-bynumber.json', import.meta.url), 'utf8'),
    );
    const r = parseByNumber(real, '2026-08-24');
    expect(r).not.toBeNull();
    expect(r!.icao24).toBe('406947');
    // Against the REAL payload, not a hand-written one: callSign is a field
    // AeroDataBox actually returns, and the pinned card had no logo for a month
    // because this parser dropped it. Asserted here so the fixture is what
    // proves the field exists, rather than a fixture written to match the code.
    expect(r!.callsign).toBe('BAW181');
    // The real payload's aircraft.model is "Boeing 777-300ER Passenger" --
    // this is what serve.ts's `ac` field renders on a pinned card.
    expect(r!.aircraftModel).toBe('Boeing 777-300ER Passenger');
  });

  it('REGRESSION: selects the en-route leg from a real multi-leg response, not the cancelled one', () => {
    // server/fixtures/aerodatabox-bynumber-multileg.json is the genuine
    // AeroDataBox response for DL182 on 2026-08-24. It has three rows: row 0
    // is a cancelled JFK->FCO leg that arrived that morning (it was actually
    // yesterday's departure), row 1 is a completely different aircraft that
    // happens to share the flight number (departed from YYT, no arrival on
    // file), and row 2 is the real en-route JFK->FCO leg departing that date.
    // Before the fix, parseByNumber took rows[0] blindly, returning the
    // cancelled leg's null departure time and leaving the whole feature inert.
    const real = JSON.parse(
      readFileSync(new URL('../../fixtures/aerodatabox-bynumber-multileg.json', import.meta.url), 'utf8'),
    );
    const r = parseByNumber(real, '2026-08-24');
    expect(r).not.toBeNull();
    expect(r!.icao24).toBe('ab20e7');
    expect(r!.origIata).toBe('JFK');
    expect(r!.destIata).toBe('FCO');
    expect(r!.schedDepEpoch).not.toBeNull();
  });

  // The date is the one at the DEPARTURE AIRPORT, not in UTC. These two are a
  // different day for any evening departure west of Greenwich -- DL1732 leaves
  // JFK at 20:55 local on the 24th, which is 00:55Z on the 25th -- and the
  // person adding the flight reads it off a boarding pass, which says the 24th.
  const jfkEvening = [{
    number: 'DL 1732',
    callSign: 'DAL1732',
    aircraft: { reg: 'N717TW', modeS: 'A997CC', model: 'Boeing 757-200' },
    departure: {
      airport: { iata: 'JFK', location: { lat: 40.6413, lon: -73.7781 } },
      scheduledTime: { utc: '2026-08-25 00:55Z', local: '2026-08-24 20:55-04:00' },
    },
    arrival: {
      airport: { iata: 'SFO', location: { lat: 37.6188, lon: -122.3756 } },
      scheduledTime: { utc: '2026-08-25 07:15Z', local: '2026-08-25 00:15-07:00' },
    },
  }];

  it('selects by the departure airport local date, not the UTC one', () => {
    const r = parseByNumber(jfkEvening, '2026-08-24');
    expect(r).not.toBeNull();
    expect(r!.icao24).toBe('a997cc');
    expect(r!.origIata).toBe('JFK');
  });

  it('does NOT select that row for the UTC date of the same departure', () => {
    // The old behaviour, now explicitly wrong: asking for the 25th must not
    // return a flight that left on the evening of the 24th.
    expect(parseByNumber(jfkEvening, '2026-08-25')).toBeNull();
  });

  it('falls back to the UTC date when a row carries no local timestamp', () => {
    // Rather than dropping an otherwise usable row outright.
    const noLocal = [{
      ...jfkEvening[0]!,
      departure: {
        ...jfkEvening[0]!.departure,
        scheduledTime: { utc: '2026-08-25 00:55Z' },
      },
    }];
    expect(parseByNumber(noLocal, '2026-08-25')).not.toBeNull();
    expect(parseByNumber(noLocal, '2026-08-24')).toBeNull();
  });

  it('rejects a cancelled row (AeroDataBox spells it "Canceled", single-l)', () => {
    const rows = [{
      status: 'Canceled',
      aircraft: { modeS: 'AB3D41' },
      departure: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-08-24 21:20Z' } },
      arrival: { airport: { iata: 'FCO' }, scheduledTime: { utc: '2026-08-25 05:55Z' } },
    }];
    expect(parseByNumber(rows, '2026-08-24')).toBeNull();
  });

  it('also tolerates the double-l "Cancelled" spelling', () => {
    const rows = [{
      status: 'Cancelled',
      aircraft: { modeS: 'AB3D41' },
      departure: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-08-24 21:20Z' } },
      arrival: { airport: { iata: 'FCO' }, scheduledTime: { utc: '2026-08-25 05:55Z' } },
    }];
    expect(parseByNumber(rows, '2026-08-24')).toBeNull();
  });

  it('does not select a row whose scheduled departure falls on a different date', () => {
    // Generalises the cancelled-leg confusion: a leg that ARRIVES on the
    // requested date is not the same thing as one that DEPARTS on it.
    const rows = [{
      status: 'Arrived',
      aircraft: { modeS: 'AB3D41' },
      departure: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-08-23 21:20Z' } },
      arrival: { airport: { iata: 'FCO' }, scheduledTime: { utc: '2026-08-24 05:55Z' } },
    }];
    expect(parseByNumber(rows, '2026-08-24')).toBeNull();
  });

  it('does not select a row with no arrival airport IATA', () => {
    // A same-numbered flight on a different aircraft, with no arrival on file
    // yet, must not be mistaken for the tracked leg.
    const rows = [{
      status: 'Departed',
      aircraft: { modeS: 'A519B8' },
      departure: { airport: { iata: 'YYT' }, scheduledTime: { utc: '2026-08-24 12:21Z' } },
      arrival: { airport: { name: 'Unknown' } },
    }];
    expect(parseByNumber(rows, '2026-08-24')).toBeNull();
  });

  it('picks the earliest scheduled departure when two rows both qualify', () => {
    const later = {
      status: 'Scheduled',
      aircraft: { modeS: 'AAAAAA' },
      departure: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-08-24 21:20Z' } },
      arrival: { airport: { iata: 'FCO' }, scheduledTime: { utc: '2026-08-25 05:55Z' } },
    };
    const earlier = {
      status: 'Scheduled',
      aircraft: { modeS: 'BBBBBB' },
      departure: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-08-24 09:00Z' } },
      arrival: { airport: { iata: 'FCO' }, scheduledTime: { utc: '2026-08-24 17:00Z' } },
    };
    const r = parseByNumber([later, earlier], '2026-08-24');
    expect(r).not.toBeNull();
    expect(r!.icao24).toBe('bbbbbb');
  });
});

describe('resolveFlight', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('calls the by-number endpoint with the date and returns a parsed row', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await resolveFlight('BA181', '2026-09-14', 'KEY');
    expect(r.ok).toBe(true);
    // `expect(r.ok).toBe(true)` doesn't narrow `r` for the type checker --
    // only a real `if` does -- so an explicit guard is needed before `r.flight`
    // is accessible under this repo's strict tsconfig.
    if (!r.ok) throw new Error('unreachable: r.ok was asserted true above');
    expect(r.flight.icao24).toBe('4008f3');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/flights/number/BA181/2026-09-14');
  });

  it('reports not-found as a terminal miss, not a transport error', async () => {
    // The distinction drives retry policy: a 404 must never be retried.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const r = await resolveFlight('BA1811', '2026-09-14', 'KEY');
    expect(r).toEqual({ ok: false, retryable: false, reason: 'not operating 2026-09-14' });
  });

  it('reports 5xx and 429 as retryable', async () => {
    for (const status of [429, 500, 503]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
      const r = await resolveFlight('BA181', '2026-09-14', 'KEY');
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable: r.ok was asserted false above');
      expect(r.retryable).toBe(true);
    }
  });

  it('reports a thrown fetch as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const r = await resolveFlight('BA181', '2026-09-14', 'KEY');
    expect(r).toEqual({ ok: false, retryable: true, reason: 'ECONNRESET' });
  });

  it('treats an empty result as terminal, not retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));
    const r = await resolveFlight('BA181', '2026-09-14', 'KEY');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable: r.ok was asserted false above');
    expect(r.retryable).toBe(false);
  });
});

describe('a status that only STARTS with "cancel"', () => {
  // MEASURED 2026-08-25, live: AA3964 on 2026-08-25 returned two legs --
  // ORD->HPN "CanceledUncertain", and HPN->ORD "Unknown" which was the one
  // actually in the air. CANCELED_STATUSES was an exact-match set of
  // {canceled, cancelled}, so "CanceledUncertain" was NOT recognised, the dead
  // leg survived the filter, and "earliest scheduled departure" then chose it.
  // The wall showed nothing and the entry sat inert.
  const payload = JSON.parse(
    readFileSync(new URL('../../fixtures/aerodatabox-bynumber-canceled-uncertain.json', import.meta.url), 'utf8'),
  );

  it('drops the cancelled leg and takes the one that is actually flying', () => {
    const r = parseByNumber(payload, '2026-08-25')!;
    expect(r).not.toBeNull();
    expect(r.origIata).toBe('HPN');
    expect(r.destIata).toBe('ORD');
  });

  it('recognises every spelling variant the provider uses', () => {
    for (const status of ['Canceled', 'Cancelled', 'CanceledUncertain', 'CancelledUncertain', 'CANCELED']) {
      const only = [{ ...payload[0], status }];
      expect(parseByNumber(only, '2026-08-25')).toBeNull();
    }
  });

  it('does not drop a status that merely contains the word later on', () => {
    // Guard against over-matching: only a LEADING "cancel" counts.
    const notCancelled = [{ ...payload[1], status: 'Uncertain' }];
    expect(parseByNumber(notCancelled, '2026-08-25')).not.toBeNull();
  });
});
