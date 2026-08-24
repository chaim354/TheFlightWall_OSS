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
    const r = parseByNumber(payload);
    expect(r).not.toBeNull();
    // Lowercased: OpenSky's icao24 is lowercase hex and comparisons elsewhere
    // assume it.
    expect(r!.icao24).toBe('4008f3');
    expect(r!.reg).toBe('G-STBA');
    expect(r!.origIata).toBe('JFK');
    expect(r!.destIata).toBe('LHR');
    expect(r!.orig).toEqual({ lat: 40.6413, lon: -73.7781 });
    expect(r!.schedDepEpoch).toBe(Math.floor(Date.parse('2026-09-14T18:00:00Z') / 1000));
    expect(r!.schedArrEpoch).toBe(Math.floor(Date.parse('2026-09-15T01:00:00Z') / 1000));
  });

  it('accepts a bare object as well as an array', () => {
    expect(parseByNumber(payload[0]!)!.icao24).toBe('4008f3');
  });

  it('returns null for an empty array (flight not operating that date)', () => {
    expect(parseByNumber([])).toBeNull();
  });

  it('returns a row with a null hex rather than null, when modeS is missing', () => {
    // "Resolved but no hex" is a DIFFERENT outcome from "no such flight", and
    // the caller reports them with different reasons. Collapsing them would
    // hide the spec's flagged risk that the by-number endpoint may not carry
    // modeS at all.
    const noHex = [{ ...payload[0]!, aircraft: { reg: 'G-STBA', model: 'B777' } }];
    const r = parseByNumber(noHex);
    expect(r).not.toBeNull();
    expect(r!.icao24).toBeNull();
    expect(r!.reg).toBe('G-STBA');
  });

  it('tolerates missing coordinates without throwing', () => {
    const noCoord = [{ ...payload[0]!, departure: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-09-14 18:00Z' } } }];
    const r = parseByNumber(noCoord);
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
    const r = parseByNumber(real);
    expect(r).not.toBeNull();
    expect(r!.icao24).toBe('406947');
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
