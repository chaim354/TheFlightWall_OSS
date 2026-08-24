import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { parseStates, fetchPosition, __resetTokenCacheForTests } from '../../src/tracked/opensky';

// OpenSky returns positional arrays, not objects. Indices, per its docs:
// 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
// 5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity,
// 10 true_track, 11 vertical_rate.
const state = (over: Partial<Record<number, unknown>> = {}): unknown[] => {
  const s: unknown[] = ['4008f3', 'BAW181 ', 'United Kingdom', 1787000000, 1787000000,
    -30.5, 52.1, 11277.6, false, 250.3, 62.1, 0];
  for (const [i, v] of Object.entries(over)) s[Number(i)] = v;
  return s;
};

describe('parseStates', () => {
  it('extracts position, altitude, track and on-ground', () => {
    const p = parseStates({ states: [state()] });
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(52.1, 4);
    expect(p!.lon).toBeCloseTo(-30.5, 4);
    expect(p!.onGround).toBe(false);
    expect(p!.headingDeg).toBeCloseTo(62.1, 1);
  });

  it('returns null when states is null or empty (aircraft not seen)', () => {
    // OpenSky returns states:null for an aircraft nobody is receiving. That is
    // the ocean-gap case, and it must be distinguishable from an error so the
    // caller dead-reckons instead of dropping the card.
    expect(parseStates({ states: null })).toBeNull();
    expect(parseStates({ states: [] })).toBeNull();
    expect(parseStates({})).toBeNull();
  });

  it('returns null when lat/lon are null but the aircraft is listed', () => {
    // A state vector with no position happens; treating null as 0 would put
    // the aircraft in the Gulf of Guinea.
    expect(parseStates({ states: [state({ 5: null, 6: null })] })).toBeNull();
  });

  it('reports on-ground when the flag is set', () => {
    expect(parseStates({ states: [state({ 8: true })] })!.onGround).toBe(true);
  });
});

// fetchPosition now authenticates via OAuth2 client-credentials (a bearer
// token from this endpoint) instead of HTTP Basic. See fetchPosition's doc
// comment in src/tracked/opensky.ts for the live measurement that made this
// change necessary: Basic auth against OpenSky's current API returns HTTP 200
// with real data, so it LOOKS fine, but it is silently served from the
// 400-request/day anonymous tier instead of the 4000/day authenticated tier.
const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const tokenResponse = (over: { token?: string; expiresIn?: number } = {}) =>
  new Response(
    JSON.stringify({
      access_token: over.token ?? 'tok-1',
      expires_in: over.expiresIn ?? 1800,
      token_type: 'Bearer',
    }),
    { status: 200 },
  );

const positionResponse = () => new Response(JSON.stringify({ states: [state()] }), { status: 200 });

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

/**
 * A `fetch` stub that routes by URL rather than by call order: a request to
 * the token endpoint consumes the next entry in `tokenReplies`, anything else
 * (the states endpoint) consumes the next entry in `dataReplies`. Routing by
 * URL -- instead of just returning queued responses in call order -- means
 * these tests keep working even if fetchPosition's internals reorder when it
 * checks the cache vs. when it builds the data request.
 *
 * Every call is recorded on the returned mock's `.mock.calls` for assertions
 * (URL, method, headers, body).
 */
function stubFetch(tokenReplies: Response[], dataReplies: Response[]) {
  let tokenIdx = 0;
  let dataIdx = 0;
  const fetchMock = vi.fn(async (...args: FetchArgs): Promise<Response> => {
    const [input] = args;
    if (String(input) === TOKEN_URL) {
      const r = tokenReplies[tokenIdx];
      tokenIdx++;
      if (!r) throw new Error('test bug: stubFetch ran out of queued token replies');
      return r;
    }
    const r = dataReplies[dataIdx];
    dataIdx++;
    if (!r) throw new Error('test bug: stubFetch ran out of queued data replies');
    return r;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchPosition', () => {
  beforeEach(() => {
    // The token cache is module state that outlives any one test -- without
    // this, a token cached by one test's mock would be reused by the next
    // test instead of that test's own mock ever being exercised.
    __resetTokenCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queries by icao24 and returns a position', async () => {
    // calls[0] is the token exchange, calls[1] is the states request -- see
    // the dedicated ordering test below, which asserts that ordering directly.
    const fetchMock = stubFetch([tokenResponse()], [positionResponse()]);
    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r.ok).toBe(true);
    // `expect(r.ok).toBe(true)` doesn't narrow `r` for the type checker --
    // only a real `if` does -- so an explicit guard is needed before `r.position`
    // is accessible under this repo's strict tsconfig.
    if (!r.ok) throw new Error('unreachable: r.ok was asserted true above');
    expect(r.position!.lat).toBeCloseTo(52.1, 4);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('icao24=4008f3');
  });

  it('distinguishes "seen but no position" from "request failed"', async () => {
    stubFetch([tokenResponse()], [new Response('{"states":null}', { status: 200 })]);
    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r).toEqual({ ok: true, position: null });
  });

  it('reports an HTTP failure as not-ok', async () => {
    stubFetch([tokenResponse()], [new Response('', { status: 429 })]);
    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r.ok).toBe(false);
  });

  it('reports a thrown fetch as not-ok rather than propagating', async () => {
    // A blanket rejection answers whichever request comes first -- the token
    // exchange, since the cache is empty (beforeEach reset it) -- so this now
    // exercises the token-fetch failure path. The assertion (ok:false, no
    // throw reaching the test) is the same either way.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));
    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r.ok).toBe(false);
  });

  it('requests a token before the first API call and sends it as a bearer token', async () => {
    const fetchMock = stubFetch([tokenResponse({ token: 'the-access-token' })], [positionResponse()]);
    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r.ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(String(tokenUrl)).toBe(TOKEN_URL);
    expect(tokenInit?.method).toBe('POST');
    expect(String(tokenInit?.headers && new Headers(tokenInit.headers).get('content-type'))).toContain(
      'application/x-www-form-urlencoded',
    );
    const body = String(tokenInit?.body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=id');
    expect(body).toContain('client_secret=secret');

    const [dataUrl, dataInit] = fetchMock.mock.calls[1]!;
    expect(String(dataUrl)).toContain('icao24=4008f3');
    expect(new Headers(dataInit?.headers).get('authorization')).toBe('Bearer the-access-token');
  });

  it('reuses the cached token across two calls instead of re-authenticating', async () => {
    const fetchMock = stubFetch([tokenResponse()], [positionResponse(), positionResponse()]);

    const r1 = await fetchPosition('4008f3', 'id', 'secret');
    const r2 = await fetchPosition('4008f3', 'id', 'secret');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Two fetchPosition calls, but only 3 fetches total (1 token + 2 data) --
    // the second call must not repeat the token exchange. This is the point
    // of caching: skipping the round trip and not hammering the auth endpoint
    // on every poll.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
  });

  it('surfaces a token fetch failure as {ok:false} instead of throwing', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) =>
      new Response('{"error":"invalid_client"}', { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r.ok).toBe(false);
    // Only the token exchange was attempted -- with no token in hand,
    // fetchPosition must not go on to call the data endpoint at all.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(TOKEN_URL);
  });

  it('treats a 401 from the data endpoint as not-ok and drops the cached token', async () => {
    const fetchMock = stubFetch(
      [tokenResponse({ token: 'tok-a' }), tokenResponse({ token: 'tok-b' })],
      [
        positionResponse(), // call 1: succeeds, caches tok-a
        new Response('', { status: 401 }), // call 2: tok-a rejected
        positionResponse(), // call 3: succeeds again, on a fresh token
      ],
    );

    const r1 = await fetchPosition('4008f3', 'id', 'secret');
    const r2 = await fetchPosition('4008f3', 'id', 'secret');
    const r3 = await fetchPosition('4008f3', 'id', 'secret');

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(true);

    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === TOKEN_URL);
    // Proof of both halves of the fix: only ONE token fetch covers calls 1
    // and 2 (the cache survived up to the 401 -- i.e. it really was reused,
    // not re-fetched out of caution), and a SECOND token fetch happens before
    // call 3 (the 401 really did clear the cache, rather than the next call
    // repeating the same doomed token). Two total is exactly the signature of
    // "reused once, then invalidated and re-requested."
    expect(tokenCalls).toHaveLength(2);
  });

  it('never sends an Authorization: Basic header (the regression this fixes)', async () => {
    const fetchMock = stubFetch([tokenResponse({ token: 'tok-1' })], [positionResponse()]);
    await fetchPosition('4008f3', 'id', 'secret');

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth !== null) expect(auth.startsWith('Basic')).toBe(false);
    }
    // Positive check so the loop above isn't vacuously true: the data request
    // really does carry a Bearer token, just never a Basic one.
    const dataAuth = new Headers(fetchMock.mock.calls[1]![1]?.headers).get('authorization');
    expect(dataAuth).toBe('Bearer tok-1');
  });
});
