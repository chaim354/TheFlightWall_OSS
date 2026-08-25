import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseAdsbdb, parseHexdb, gateRoute, lookupRoute, resolveGatedRoute,
  resetRouteCache, routeCacheSize, type RouteFix,
} from '../src/routes/routeLookup';

const NOW = 1_787_000_000_000;

/** Real adsbdb shape, trimmed to the fields the parser reads (captured live). */
const adsbdbLaxJfk = {
  response: {
    flightroute: {
      callsign: 'AAL118', callsign_iata: 'AA118',
      airline: { name: 'American Airlines', icao: 'AAL', iata: 'AA' },
      origin: { iata_code: 'LAX', icao_code: 'KLAX', latitude: 33.942501, longitude: -118.407997, name: 'Los Angeles International Airport' },
      destination: { iata_code: 'JFK', icao_code: 'KJFK', latitude: 40.639801, longitude: -73.7789, name: 'John F Kennedy International Airport' },
    },
  },
};

const okResponse = (body: string) => ({ ok: true, status: 200, text: async () => body });
const notFound = () => ({ ok: false, status: 404, text: async () => '' });

beforeEach(() => resetRouteCache());

describe('parseAdsbdb', () => {
  it('extracts both ends with coordinates', () => {
    const r = parseAdsbdb(adsbdbLaxJfk)!;
    expect(r.origIata).toBe('LAX');
    expect(r.destIata).toBe('JFK');
    expect(r.origLat).toBeCloseTo(33.9425, 3);
    expect(r.destLon).toBeCloseTo(-73.7789, 3);
    expect(r.source).toBe('adsbdb');
  });

  it('rejects a route missing coordinates rather than returning an ungateable one', () => {
    // The corridor gate is the ONLY thing making this source safe. A route it
    // cannot check is worse than no route, so it must not be returned at all.
    const noCoords = structuredClone(adsbdbLaxJfk) as Record<string, any>;
    delete noCoords.response.flightroute.origin.latitude;
    expect(parseAdsbdb(noCoords)).toBeNull();
  });

  it('degrades to null on junk instead of throwing', () => {
    for (const j of [null, undefined, 42, 'nope', {}, { response: {} }, { response: { flightroute: {} } }]) {
      expect(() => parseAdsbdb(j)).not.toThrow();
      expect(parseAdsbdb(j)).toBeNull();
    }
  });
});

describe('parseHexdb', () => {
  it('resolves a bare ICAO pair through the airport table', () => {
    const r = parseHexdb('KLAX-KJFK')!;
    expect(r.origIata).toBe('LAX');
    expect(r.destIata).toBe('JFK');
    expect(r.source).toBe('hexdb');
    expect(r.destLat).toBeCloseTo(40.6398, 2);
  });

  it('returns null for an airport the bundled table does not cover', () => {
    expect(parseHexdb('ZZZZ-KJFK')).toBeNull();
  });

  it('returns null for anything that is not an ICAO pair', () => {
    for (const j of ['', 'unknown', 'KLAX', 'KLAX-KJFK-KBOS', null, 42, '<html>404</html>']) {
      expect(parseHexdb(j)).toBeNull();
    }
  });
});

describe('gateRoute: the check that makes a 32%-wrong source usable', () => {
  const laxJfk: RouteFix = {
    origIata: 'LAX', origLat: 33.9425, origLon: -118.408,
    destIata: 'JFK', destLat: 40.6398, destLon: -73.7789, source: 'adsbdb',
    flightIata: null, airlineName: null,
  };

  it('accepts an aircraft actually on the corridor', () => {
    // Roughly mid-route, over the Midwest.
    expect(gateRoute(laxJfk, 39.8, -95.0)).not.toBeNull();
  });

  it('accepts an aircraft near the destination', () => {
    expect(gateRoute(laxJfk, 40.7, -74.2)).not.toBeNull();
  });

  it('REJECTS a stale route for a leg this aircraft is not flying', () => {
    // The failure mode this exists for: adsbdb answers with yesterday's route.
    // An aircraft over Miami is nowhere near the LAX-JFK line.
    expect(gateRoute(laxJfk, 25.79, -80.29)).toBeNull();
  });

  it('rejects an aircraft far off-corridor even when between the endpoints in longitude', () => {
    // Longitude alone is not the test -- the Gulf of Mexico sits "between" LAX
    // and JFK on that axis while being hundreds of km off the great circle.
    expect(gateRoute(laxJfk, 26.0, -92.0)).toBeNull();
  });

  it('uses the same bound join.ts applies to schedule rows', async () => {
    // Not an independently tuned number: 300km was measured on live data
    // (6 of 17 wrong destinations caught, zero false positives) and both
    // callers must agree, or a route rejected as a schedule row could be
    // accepted as a fallback.
    const { MAX_CORRIDOR_EXCESS_KM } = await import('../src/join');
    expect(MAX_CORRIDOR_EXCESS_KM).toBe(300);
  });
});

describe('lookupRoute', () => {
  it('prefers adsbdb and does not call hexdb when it answers', async () => {
    const urls: string[] = [];
    const fake = (async (u: string) => {
      urls.push(u);
      return okResponse(JSON.stringify(adsbdbLaxJfk));
    }) as unknown as typeof fetch;

    const r = await lookupRoute('AAL118', NOW, { fetchImpl: fake });
    expect(r?.source).toBe('adsbdb');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('adsbdb.com');
  });

  it('falls through to hexdb when adsbdb has nothing', async () => {
    const fake = (async (u: string) =>
      u.includes('adsbdb') ? notFound() : okResponse('KLAX-KJFK')) as unknown as typeof fetch;
    const r = await lookupRoute('AAL118', NOW, { fetchImpl: fake });
    expect(r?.source).toBe('hexdb');
    expect(r?.destIata).toBe('JFK');
  });

  it('skips tail numbers without spending a request', async () => {
    // N-numbers and military callsigns are never in these databases; asking
    // burns the per-cycle budget on flights that can never resolve.
    let calls = 0;
    const fake = (async () => { calls++; return notFound(); }) as unknown as typeof fetch;
    for (const cs of ['N385FR', 'GRYDR18', '', 'MX621JB']) {
      expect(await lookupRoute(cs, NOW, { fetchImpl: fake })).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it('caches a hit so a flight overhead for many cycles costs one request', async () => {
    let calls = 0;
    const fake = (async () => { calls++; return okResponse(JSON.stringify(adsbdbLaxJfk)); }) as unknown as typeof fetch;
    for (let i = 0; i < 5; i++) await lookupRoute('AAL118', NOW + i * 1000, { fetchImpl: fake });
    expect(calls).toBe(1);
  });

  it('caches a MISS too, so unresolvable callsigns do not re-ask every cycle', async () => {
    let calls = 0;
    const fake = (async () => { calls++; return notFound(); }) as unknown as typeof fetch;
    for (let i = 0; i < 4; i++) await lookupRoute('AAL999', NOW + i * 1000, { fetchImpl: fake });
    expect(calls).toBe(2); // one adsbdb + one hexdb, then cached
  });

  it('re-asks after a miss expires, but much sooner than after a hit', async () => {
    let calls = 0;
    const fake = (async () => { calls++; return notFound(); }) as unknown as typeof fetch;
    await lookupRoute('AAL999', NOW, { fetchImpl: fake });
    await lookupRoute('AAL999', NOW + 29 * 60_000, { fetchImpl: fake }); // inside 30m
    expect(calls).toBe(2);
    await lookupRoute('AAL999', NOW + 31 * 60_000, { fetchImpl: fake }); // past it
    expect(calls).toBe(4);
  });

  it('survives a transport failure without throwing', async () => {
    const fake = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(lookupRoute('AAL118', NOW, { fetchImpl: fake })).resolves.toBeNull();
  });

  it('survives adsbdb returning non-JSON', async () => {
    const fake = (async (u: string) =>
      u.includes('adsbdb') ? okResponse('<html>oops</html>') : okResponse('KLAX-KJFK')) as unknown as typeof fetch;
    const r = await lookupRoute('AAL118', NOW, { fetchImpl: fake });
    expect(r?.source).toBe('hexdb'); // fell through rather than blowing up
  });

  it('bounds the cache so a long-running process cannot grow unboundedly', async () => {
    const fake = (async () => okResponse(JSON.stringify(adsbdbLaxJfk))) as unknown as typeof fetch;
    for (let i = 0; i < 2100; i++) await lookupRoute(`AAL${i}`, NOW, { fetchImpl: fake });
    expect(routeCacheSize()).toBeLessThanOrEqual(2000);
  });
});

describe('resolveGatedRoute', () => {
  it('returns a route only when the aircraft is on its corridor', async () => {
    const fake = (async () => okResponse(JSON.stringify(adsbdbLaxJfk))) as unknown as typeof fetch;
    // On corridor.
    expect(await resolveGatedRoute('AAL118', 39.8, -95.0, NOW, { fetchImpl: fake })).not.toBeNull();
    // Same lookup, aircraft over Miami: the gate rejects it.
    expect(await resolveGatedRoute('AAL118', 25.79, -80.29, NOW, { fetchImpl: fake })).toBeNull();
  });

  it('still caches the lookup even when the gate rejects it', async () => {
    // The route is not wrong, the AIRCRAFT is elsewhere -- so the answer is
    // still worth remembering for the next aircraft using that callsign.
    let calls = 0;
    const fake = (async () => { calls++; return okResponse(JSON.stringify(adsbdbLaxJfk)); }) as unknown as typeof fetch;
    await resolveGatedRoute('AAL118', 25.79, -80.29, NOW, { fetchImpl: fake });
    await resolveGatedRoute('AAL118', 39.8, -95.0, NOW, { fetchImpl: fake });
    expect(calls).toBe(1);
  });
});

describe('lookupRoute: a non-answer is not a negative answer', () => {
  // F-SRV08-A. getText returned the same null for 404, 429, 502, a timeout and
  // a DNS failure, and cacheSet derived the TTL from the payload alone -- so a
  // single 3s timeout (the default, which flights.ts uses by passing no opts)
  // blanked that callsign's route for THIRTY MINUTES. On a module that exists
  // as the last resort for flights that would otherwise render blank, for an
  // aircraft typically overhead a few minutes. An IP-level block or a 429
  // poisoned every callsign asked during it.
  //
  // The 30-minute rationale in the module is written entirely about the
  // definitively-ANSWERED case ("most callsigns these databases do not know are
  // ones they will never know"). It was never written for a timeout. The
  // firmware's equivalent cache already uses a failure TTL 30x shorter.

  const FAIL_TTL_MS = 60_000;

  const countingFetch = (make: () => unknown) => {
    const state = { calls: 0 };
    const impl = (async () => { state.calls++; return make(); }) as unknown as typeof fetch;
    return { state, impl };
  };

  it('retries within a minute after a timeout, not after half an hour', async () => {
    const { state, impl } = countingFetch(() => { throw new Error('The operation was aborted'); });

    await lookupRoute('AAL777', NOW, { fetchImpl: impl });
    const afterFirst = state.calls;

    // Still inside the negative TTL a definitive 404 would have earned.
    await lookupRoute('AAL777', NOW + FAIL_TTL_MS + 1000, { fetchImpl: impl });
    expect(state.calls).toBeGreaterThan(afterFirst);
  });

  it('treats a 429 as unreachable, not as "this route does not exist"', async () => {
    const { state, impl } = countingFetch(() => ({ ok: false, status: 429, text: async () => '' }));

    await lookupRoute('AAL778', NOW, { fetchImpl: impl });
    const afterFirst = state.calls;
    await lookupRoute('AAL778', NOW + FAIL_TTL_MS + 1000, { fetchImpl: impl });
    expect(state.calls).toBeGreaterThan(afterFirst);
  });

  it('treats a 502 as unreachable too', async () => {
    const { state, impl } = countingFetch(() => ({ ok: false, status: 502, text: async () => '' }));

    await lookupRoute('AAL779', NOW, { fetchImpl: impl });
    const afterFirst = state.calls;
    await lookupRoute('AAL779', NOW + FAIL_TTL_MS + 1000, { fetchImpl: impl });
    expect(state.calls).toBeGreaterThan(afterFirst);
  });

  it('still remembers a definitive 404 for the full half hour', async () => {
    // The asymmetry is deliberate and must survive: a callsign these databases
    // genuinely do not know is one they will probably never know, and re-asking
    // every cycle would spend the whole budget on GA and military traffic.
    const { state, impl } = countingFetch(() => notFound());

    await lookupRoute('AAL780', NOW, { fetchImpl: impl });
    const afterFirst = state.calls;
    await lookupRoute('AAL780', NOW + FAIL_TTL_MS + 1000, { fetchImpl: impl });
    expect(state.calls).toBe(afterFirst); // still cached, unlike the cases above
  });

  it('counts a 200 with an unparseable body as answered', async () => {
    // A reply IS an answer, even one we could not use -- so it earns the long
    // negative TTL, not the short retry.
    const { state, impl } = countingFetch(() => okResponse('<html>nope</html>'));

    await lookupRoute('AAL781', NOW, { fetchImpl: impl });
    const afterFirst = state.calls;
    await lookupRoute('AAL781', NOW + FAIL_TTL_MS + 1000, { fetchImpl: impl });
    expect(state.calls).toBe(afterFirst);
  });

  it('does not let a good route be replaced by a short-lived non-answer', async () => {
    // On expiry of a good 6h entry, cacheGet has already deleted it -- so a
    // failed refetch used to install a 30-minute negative over known-good data.
    let mode: 'ok' | 'down' = 'ok';
    const impl = (async () => {
      if (mode === 'down') throw new Error('ECONNRESET');
      return okResponse(JSON.stringify(adsbdbLaxJfk));
    }) as unknown as typeof fetch;

    expect(await lookupRoute('AAL118', NOW, { fetchImpl: impl })).not.toBeNull();

    const afterExpiry = NOW + 6 * 60 * 60 * 1000 + 1000;
    mode = 'down';
    expect(await lookupRoute('AAL118', afterExpiry, { fetchImpl: impl })).toBeNull();

    // Back up a minute later: the route must be resolvable again, not blanked
    // for another 29 minutes.
    mode = 'ok';
    const back = await lookupRoute('AAL118', afterExpiry + FAIL_TTL_MS + 1000, { fetchImpl: impl });
    expect(back).not.toBeNull();
    expect(back!.destIata).toBe('JFK');
  });
});

describe('parseAdsbdb: the identity fields alongside the route', () => {
  /** A Norse Atlantic UK reply — the case that showed a route and no airline. */
  const norse = () => ({
    response: {
      flightroute: {
        callsign: 'UBT70A',
        callsign_icao: 'UBT70A',
        callsign_iata: 'Z070A',
        airline: { name: 'Norse Atlantic UK', icao: 'UBT', iata: 'Z0' },
        origin: { iata_code: 'LGW', latitude: 51.148102, longitude: -0.190278 },
        destination: { iata_code: 'JFK', latitude: 40.639801, longitude: -73.7789 },
      },
    },
  });

  it('takes the IATA flight number the same response already carries', () => {
    // UBT70A cannot reach the schedule table: callsignKey rejects a trailing
    // letter, so matchSchedule returns null and flt stays null -- while THIS
    // field, in the reply we already fetched for the route, is the answer.
    expect(parseAdsbdb(norse())!.flightIata).toBe('Z070A');
  });

  it('takes the operator name too', () => {
    expect(parseAdsbdb(norse())!.airlineName).toBe('Norse Atlantic UK');
  });

  it('still returns the route when the identity fields are absent', () => {
    const bare = norse() as Record<string, any>;
    delete bare.response.flightroute.callsign_iata;
    delete bare.response.flightroute.airline;
    const r = parseAdsbdb(bare)!;
    expect(r.origIata).toBe('LGW');
    expect(r.flightIata).toBeNull();
    expect(r.airlineName).toBeNull();
  });

  it('refuses a name that is only the carrier code, which must not outrank the wall', () => {
    // airlines.ts: a bare code read as a name pre-empted "Saudia" from the
    // device's own better-stocked table. Null lets that table answer.
    const coded = norse() as Record<string, any>;
    coded.response.flightroute.airline.name = 'UBT';
    expect(parseAdsbdb(coded)!.airlineName).toBeNull();
    coded.response.flightroute.airline.name = 'Z0';
    expect(parseAdsbdb(coded)!.airlineName).toBeNull();
  });

  it('reports null identity for hexdb, which carries no such data', () => {
    const r = parseHexdb('EGKK-KJFK')!;
    expect(r.flightIata).toBeNull();
    expect(r.airlineName).toBeNull();
  });
});
