const BASE = 'https://opensky-network.org/api/states/all';
const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

/**
 * Refresh this many ms before the token's stated `expires_in`, not exactly at
 * it. `expires_in` is measured from when OpenSky issued the token, not from
 * the moment a caller here checks the cache -- without a safety margin, a
 * token that reads as valid at the check can expire in the time it takes the
 * request to reach OpenSky, coming back as a 401 that costs a whole poll
 * cycle to recover from.
 */
const EARLY_REFRESH_MS = 60_000;

export interface OpenSkyPosition {
  lat: number;
  lon: number;
  altitudeFt: number | null;
  headingDeg: number | null;
  onGround: boolean;
  seenAtEpoch: number | null;
}

export type PositionResult =
  | { ok: true; position: OpenSkyPosition | null }
  | { ok: false; reason: string };

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const M_TO_FT = 3.280839895;

/**
 * Map an OpenSky /states/all body to one position, or null if nobody is
 * receiving that aircraft.
 *
 * OpenSky returns POSITIONAL ARRAYS, not objects, so every field here is an
 * index into an undocumented-by-shape tuple. The indices are from its API docs;
 * the test pins them with a realistic vector so a reordering upstream fails
 * loudly rather than silently swapping latitude and longitude.
 *
 * null is "not currently seen", which is the ocean-gap case and NOT an error --
 * the caller responds by dead-reckoning, so conflating it with a failure would
 * drop the card exactly when the estimate is most wanted.
 */
export function parseStates(body: unknown): OpenSkyPosition | null {
  const states = (body as { states?: unknown } | null)?.states;
  if (!Array.isArray(states) || states.length === 0) return null;
  const s = states[0];
  if (!Array.isArray(s)) return null;

  const lon = num(s[5]);
  const lat = num(s[6]);
  // A listed aircraft with no fix is common. Coercing null to 0 would place it
  // off the coast of Africa, which is the plausible-looking-wrong-value failure
  // this codebase already guards against elsewhere.
  if (lat === null || lon === null) return null;

  const altM = num(s[7]);
  return {
    lat,
    lon,
    altitudeFt: altM === null ? null : Math.round(altM * M_TO_FT),
    headingDeg: num(s[10]),
    onGround: s[8] === true,
    seenAtEpoch: num(s[3]),
  };
}

interface CachedToken {
  accessToken: string;
  /** Already has EARLY_REFRESH_MS subtracted -- compare directly against Date.now(). */
  expiresAtMs: number;
}

/**
 * Module scope, so a token survives across ticks instead of being fetched
 * per poll -- see getAccessToken's doc comment for why that matters.
 *
 * Assumes one fixed (clientId, clientSecret) pair for the process lifetime,
 * which is how this feature is actually configured (one config-loaded
 * credential passed to every call); it does not key the cache per-credential.
 */
let cachedToken: CachedToken | null = null;

/**
 * Test-only escape hatch. The cache above is module state that outlives any
 * one test, so without a way to clear it a token fetched under one test's
 * mocked `fetch` leaks into the next test and hides whether that test's own
 * mock is even exercised. Call from `beforeEach`.
 */
export function __resetTokenCacheForTests(): void {
  cachedToken = null;
}

type TokenResult = { ok: true; token: string } | { ok: false; reason: string };

/**
 * OAuth2 client-credentials token, cached in module scope and refreshed only
 * when near expiry.
 *
 * `expires_in` is 1800s and this is polled every couple of minutes, so
 * fetching a fresh token per call would waste a round trip on every single
 * poll and hammer the auth endpoint for no reason -- the whole point of this
 * cache is that most calls skip the token request entirely.
 */
async function getAccessToken(clientId: string, clientSecret: string): Promise<TokenResult> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now) {
    return { ok: true, token: cachedToken.accessToken };
  }

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, reason: `token HTTP ${res.status}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'unparseable token response' };
  }

  const accessToken = (body as { access_token?: unknown } | null)?.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { ok: false, reason: 'token response missing access_token' };
  }
  const expiresIn = (body as { expires_in?: unknown } | null)?.expires_in;
  const expiresInMs =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn * 1000 : 0;

  cachedToken = { accessToken, expiresAtMs: now + expiresInMs - EARLY_REFRESH_MS };
  return { ok: true, token: accessToken };
}

/**
 * One OpenSky lookup for a single transponder address.
 *
 * Filtering by icao24 rather than fetching an area is what keeps this cheap
 * enough to run per tick -- see the credit measurement in
 * docs/superpowers/audits/2026-08-24-tracked-flights-measurements.md.
 *
 * Authenticates via OAuth2 client-credentials (a cached bearer token), NOT
 * HTTP Basic. Measured live against OpenSky's current API: Basic auth still
 * returns HTTP 200 with real data -- no error, nothing to catch -- but is
 * silently served from the anonymous tier (400 requests/day) instead of the
 * authenticated tier (4000/day) the credentials are actually entitled to.
 * `x-rate-limit-remaining` measured 395 (of 400) under Basic auth and 3999
 * (of 4000) under a bearer token from this same exchange, back to back. A
 * tenfold budget error that produces no error is the entire reason this
 * function does not use Basic auth.
 */
export async function fetchPosition(
  icao24: string,
  clientId: string,
  clientSecret: string,
): Promise<PositionResult> {
  const tok = await getAccessToken(clientId, clientSecret);
  if (!tok.ok) return { ok: false, reason: tok.reason };

  const url = `${BASE}?icao24=${encodeURIComponent(icao24.toLowerCase())}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${tok.token}` } });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 401) {
    // The bearer token we sent was rejected -- unlike Basic auth's silent
    // downgrade, this IS visible, but only if we act on it: drop the cache so
    // the NEXT call re-authenticates instead of retrying the same doomed
    // token every tick until it happens to expire on its own.
    cachedToken = null;
    return { ok: false, reason: `HTTP ${res.status}` };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  try {
    return { ok: true, position: parseStates(await res.json()) };
  } catch {
    return { ok: false, reason: 'unparseable response' };
  }
}
