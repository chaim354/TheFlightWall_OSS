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

## 4. OpenSky credit cost — NOT MEASURED, BLOCKED

No OpenSky credentials exist:

- `server/.kamal/secrets` has no `OPENSKY_*` entry.
- The device holds `openSkyClientId = chaim354@gmail.com-api-client` but reports
  `openSkyClientSecretSet = false`, so the secret was never stored there either.

**What this blocks:** only the poll-cadence tuning and the live end-to-end check
(Task 14 step 3). It does NOT block implementation -- `src/tracked/opensky.ts`
is unit-tested against a mocked `fetch`, so Task 7 proceeds as written.

**Until measured, the 60s cadence in Task 11 is an assumption**, resting on 1
credit per single-`icao24` query. If the real cost is higher the cadence must
rise before the feature ships, or one long-haul will exhaust the daily
allowance. Re-run this when a secret exists:

```bash
curl -s -u "$OPENSKY_CLIENT_ID:$OPENSKY_CLIENT_SECRET" -D /tmp/h.txt \
  "https://opensky-network.org/api/states/all?icao24=406947" -o /dev/null
grep -i "x-rate-limit" /tmp/h.txt
```

Call it twice; the delta in `X-Rate-Limit-Remaining` is the per-query cost.
