# Fixtures

Recorded provider responses used by the test suite. All of it is public
flight-schedule and ADS-B position data — nothing here needs redaction.

## fids-kjfk.json — AeroDataBox FIDS

**Captured:** 2026-08-20, ~21:29 UTC.
**Endpoint:** RapidAPI surface — `GET https://aerodatabox.p.rapidapi.com/flights/airports/icao/KJFK/{from}/{to}?withLeg=true&direction=Both`, header `x-rapidapi-key`. `{from}`/`{to}` spanned a 4-hour window around 2026-08-20T21:30Z.
**Rows:** 261 (131 arrivals + 130 departures).

This closes out Task 1 Steps 4–6 of the server plan, which were blocked on
having an AeroDataBox key. Both unknowns below were **measured**, not assumed
— see `docs/superpowers/plans/2026-08-20-flightwall-server-worker.md`, Task 1,
for where this feeds back into the plan.

### Unknown #1 — credit tier: Tier 2, 2 units/call

Measured directly from the RapidAPI response headers around the capture call:
`x-ratelimit-api-units-remaining` moved 596 → 594, and
`x-ratelimit-requests-remaining` moved 2398 → 2397 (a separate, unweighted
request counter — the *units* figure is the real budget). Free tier is 600
units/month. Four boards (KJFK/KLGA/KEWR/KBOS) at four refreshes/day is
4 × 4 × 2 units × 30 days ≈ 960 units/month — over the free tier, so this
needs the **$5/mo Pro tier (6,000 units/month)**, which leaves roughly 6x
headroom over projected use.

(Separately, while building the far-end airport-coordinate table used by the
schedule parser, AeroDataBox's Airport-by-ICAO endpoint measured as **Tier
1 — 1 unit/call**, confirmed the same way plus an explicit `x-tier: Tier 1`
response header. That endpoint is not called at runtime by this Worker — it
was used once, here, to build a static table. See `src/schedule/airports.ts`.)

### Unknown #2 — the callsign field: `callSign`, and it IS the operating callsign, but coverage is partial

Confirmed on real rows in this fixture: `number: "DL 5460"` carries
`callSign: "EDV5460"` while `airline.icao` is `DAL` (Delta) — Endeavor Air
operating a Delta Connection flight. Same pattern on `number: "DL 4659"` →
`callSign: "SKW4659"` (SkyWest). This is exactly the operator-vs-marketing-
carrier split the join in `src/join.ts` exists to resolve, so the
exact-callsign match path is live whenever the field is present.

**Coverage by `status`, measured against this fixture's 261 rows:**

| status | rows | have `callSign` |
|---|---|---|
| `Expected` | 136 | 99 (72.8%) |
| `Unknown` | 125 | 17 (13.6%) |
| all | 261 | 116 (44.4%) |

A separate, wider capture (same board, ~14-hour forward window instead of 4,
453 rows) measured 122/453 = 26.9% overall coverage. Coverage drops as the
window widens — AeroDataBox appears to assign an operating callsign only as a
flight gets closer to active/confirmed status.

**Conclusion: both join paths are live in production, not one live and one
dead.** The exact-callsign path handles the majority of near-term,
`Expected`-status flights; the number + carrier-candidate + geometry fallback
carries the rest, which on a wider fetch window is most of the table.

### Far-end airport coordinates

FIDS rows carry **no coordinates for either airport** — confirmed by grepping
the full 261-row fixture for `lat`, `lon`, and `location`; the only hits are
two false positives ("Citation *Latitude*", an aircraft model name, and
"*Lon*don", a city name). The far end of a leg carries only
`{icao, iata, name, countryCode, timeZone}`.

`src/schedule/airports.ts` fills both ends from one generated table,
`getAirportCoord()`, covering 4,565 airports worldwide — built from
OurAirports' public-domain `airports.csv` by `tools/gen-airports.js`, not
fetched or hand-maintained one ICAO at a time. This fixture's 109 distinct
far-end airports are a floor this table is checked against
(`test/airports.test.ts`), not the whole of what it covers; see that file and
`src/schedule/airports.ts`'s header comment for the filter/key logic and the
(much smaller, residual) coverage gap that remains: an airport OurAirports
does not classify as `large_airport`/`medium_airport`, or does not catalogue
at all.

## panynj-*.json — Port Authority of New York and New Jersey flight boards

**Captured:** 2026-08-21, ~14:47 UTC (10:47 ET).
**Endpoint:** `POST https://www.jfkairport.com/api/graphql`, `content-type: text/plain`, body = the JSON request payload run through lz-string's `compressToEncodedURIComponent`. Window was a +/-3h range in New York local time; `limit: 500`.
**Files:** `panynj-jfk-arrivals.json` (500 rows, page 1 of 2), `panynj-lga-departures.json` (336 rows, complete), `panynj-queries.json` (the two request payloads, decompressed).

Free, no key, no session — verified working from a plain Node process with no
cookies or browser context.

### Why the query text is stored verbatim

The endpoint matches the query TEXT against an allowlist. A query differing
from theirs only in **whitespace** (`paging { next __typename }` collapsed onto
one line) is rejected with a 400 and an HTML error page. `panynj-queries.json`
therefore holds both queries exactly as captured, and `test/panynj.test.ts`
asserts `src/schedule/panynj.ts` still reproduces them byte-for-byte — so a
Port Authority redeploy that reformats them fails a test here rather than
silently 400ing in production.

### What these boards give that AeroDataBox does not

| | AeroDataBox | Port Authority |
|---|---|---|
| cost | billable | free |
| refresh | 6-hourly, window centred on build time | minutes, window centred on now |
| revised arrival time | 102/261 (39%) | 482/500 (96%) |
| carrier + number | one `"B6 1184"` string to split | separate `airlineCode` / `flightNumber` fields |
| operating callsign | 116/261 (44%) | never |
| arrival time on a DEPARTURES row | yes (far end) | no such field |
| BOS | yes | no — Massport, not Port Authority |

The last three rows are why `refresh.ts` merges the two sources rather than
replacing one with the other.

### Measured quirks

- `dateRevised` is **always null** (0/500 and 0/336) even when `timeRevised` is
  set, so the revised date must be inferred from `dateScheduled` — with
  midnight-rollover handling, or an 11:50 PM flight revised to 12:20 AM reads
  as 23.5 hours early instead of 30 minutes late.
- Times are New York **local**, 12-hour (`"09:40 AM"`), so DST matters.
- Codeshares are included and inflate JFK 3-4x: one JFK->ORD departure appeared
  15 times, under VS/DL/SK/LA/KQ among others.
- `status` includes `Cancelled`, which the parser drops.

### Rate limiting — the safe rate is NOT established

The endpoint answers **403** when it decides we have asked for too much; the
block is per-origin and time-based, and while it holds every request fails,
including ones that succeeded moments earlier. It was tripped twice while this
adapter was being built and cleared on its own both times.

A deliberate probe — 18 requests at 2s spacing over 5 minutes — drew no
throttling, suggesting a 10-minute/8-request cadence had ample headroom. **That
did not hold**, twice over:

- A later, lighter burst was refused, so the accounting window is longer than
  the probe measured and the probe's own traffic counted toward it.
- **Blocks escalate.** The first block cleared in ~15–20 minutes. The second,
  after only modest extra traffic, had not cleared after 40 minutes of
  five-minute polling.
- The probe was run from a **residential** IP. That says nothing about a
  datacenter one, so the cadence it suggested was measured on the wrong
  machine — an error worth naming, because the number looked authoritative.
- The OVH box was refused **403 on its first ever request**, with and without a
  browser `User-Agent`.

**The source therefore ships disabled** (`panynjIntervalMs: 0`). The adapter is
correct and tested; it is the endpoint's willingness to serve this deployment
that is missing. Re-enable only from an egress that is actually allowed, and
re-measure from that host rather than trusting anything above.
