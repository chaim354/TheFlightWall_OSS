# Tracked flights — Task 1 measurements

**Dated record.** Measured 2026-08-24 against the live AeroDataBox subscription.
Task 1 of `docs/superpowers/plans/2026-08-24-tracked-flights.md`.

## 1. Does `/flights/number/{n}/{date}` carry `modeS`? — YES

The whole design rests on this: without a transponder hex there is nothing to
ask OpenSky about.

```
GET https://aerodatabox.p.rapidapi.com/flights/number/BA181/2026-08-24
  -> HTTP 200, 1412 bytes, one row
```

```json
"aircraft": { "reg": "G-STBG", "modeS": "406947", "model": "Boeing 777-300ER Passenger" }
```

Everything the resolver needs is present:

| Field | Value observed |
|---|---|
| `aircraft.modeS` | `406947` (6 hex digits, uppercase -- lowercase it for OpenSky) |
| `aircraft.reg` | `G-STBG` |
| `callSign` | `BAW181` |
| `number` | `BA 181` (**with a space** -- normalise before comparing) |
| `status` | `Arrived` |
| `departure.airport.iata` / `.location` | `LHR` / `{lat: 51.4706, lon: -0.461941}` |
| `arrival.airport.iata` | `JFK` |
| `scheduledTime.utc` | `2026-08-24 11:30Z` (**space, not `T`** -- `Date.parse` needs the swap) |

Top-level keys: `aircraft`, `airline`, `arrival`, `callSign`, `codeshareStatus`,
`departure`, `greatCircleDistance`, `isCargo`, `lastUpdatedUtc`, `number`,
`status`.

Fixture saved to `server/fixtures/aerodatabox-bynumber.json`.

**The plan's escape hatch is not needed.** Tasks 6-9 proceed as written; there is
no reg-to-hex fallback to cost.

Note BA181 is **LHR->JFK**, not JFK->LHR as the plan's test fixtures assume. The
direction does not affect the parser, but do not "fix" the test data to match
this row.

## 2. Two traps that cost time here — read before repeating this

**The key is 1Password-indirected.** `server/.kamal/secrets` contains
`AERODATABOX_KEY=$(op ...)`, not a literal. Extracting it with `grep | cut`
yields the 47-character command string, and sending that returns:

```
HTTP 403  {"message":"You are not subscribed to this API."}
```

That message is a lie about the cause -- it reads as a plan/subscription
problem, and it produced exactly that wrong conclusion before the hashes were
compared. **Source the file instead:**

```bash
cd server && set -a && . ./.kamal/secrets && set +a
```

Confirm before drawing any conclusion from a 403: the real key is 50 characters,
`sha256` prefix `d3d6872c`, and matches what the running container holds. Compare
hashes rather than printing either value.

**Rate limit is tight.** Three calls in quick succession returned
`429 {"message":"Too many requests"}`. Space probe calls out.

## 3. Host and headers (the plan had these wrong)

Confirmed from the working `src/schedule/aerodatabox.ts`, not from documentation:

```
host:    aerodatabox.p.rapidapi.com
headers: x-rapidapi-key: <key>
         x-rapidapi-host: aerodatabox.p.rapidapi.com
```

The plan originally specified `prod.api.market/api/v1/aedbx/aerodatabox` with an
`x-magicapi-key` header. Both were wrong and are corrected in the plan.

## 4. OpenSky — MEASURED 2026-08-24, and both findings change the design

### 4a. Basic auth does not authenticate. It silently serves the anonymous tier.

The implementation shipped in Task 7 used HTTP Basic. Against the current API
that returns HTTP 200 with real data while being billed as anonymous:

| Scheme | `x-rate-limit-remaining` | Tier |
|---|---|---|
| `Authorization: Basic base64(id:secret)` | **395** | anonymous, 400/day |
| `Authorization: Bearer <token>` | **3999** | authenticated, 4000/day |

A tenfold budget error producing no error and no wrong data -- only a tenth of
the quota, which surfaces weeks later as unexplained throttling. Fixed: OAuth2
client credentials against

```
POST https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token
     grant_type=client_credentials&client_id=<id>&client_secret=<secret>
  -> {"access_token": "<~1486 chars>", "expires_in": 1800, "token_type": "Bearer"}
```

An invalid or expired token returns **401** rather than falling back to
anonymous, so that failure at least IS visible. The token is cached and refreshed
60s early; a 401 clears the cache.

### 4b. A single-icao24 query costs FOUR credits, not one.

Measured across three consecutive calls: remaining went 3995 -> 3991 -> 3987.

That is the number the spec's cadence rested on, and it was wrong by 4x. The
budget is therefore **1,000 queries/day, not 4,000**:

```
concurrent_flights x airborne_hours x 3600 / cadence_seconds  <=  1000
```

| Cadence | 1 flight x 8h | 2 x 8h | 4 x 8h |
|---|---|---|---|
| 60s (the plan's original) | 480 | 960 | 1920 **over** |
| **120s (adopted)** | 240 | 480 | **960 fits** |

So the spec's claim of "4-6 concurrent long-hauls" at 60s was wrong on two
counts at once -- the tier was 10x smaller than assumed AND each query costs 4x
more than assumed. **Task 11 uses 120s**, which supports four concurrent
eight-hour flights inside the authenticated allowance.

Note the daily allowance is shared with nothing else today: no other code path in
this repo calls OpenSky. The device holds an `openSkyClientId` but its secret was
never set, so the firmware has never authenticated against it.
