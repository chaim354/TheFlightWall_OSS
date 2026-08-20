# Server-mediated route + ETA — design

**Status: DESIGN, not implemented.** Supersedes the enrichment path in
`docs/data-sources.md` for Area mode. Written 2026-08-19.

## Why

The wall shows the wrong destination most of the time. Measured against
Flightradar24 on live NYC traffic:

```
adsbdb + hexdb (current default), n=25 airliners
  destination CORRECT          8   32%
  reversed leg                 3   12%
  wrong leg entirely          14   56%
  --> unusable                17   68%
```

Independent confirmation that this is not FR24 being wrong: **16% of adsbdb's
answers are geometrically impossible.** `SWA1304` was returned as SFO-LAX while
the aircraft was physically over New York, 4,000 km from either endpoint.
`UAL1630` was returned as SEA-DEN at 75 ft on the ground at Newark.

### Root cause: key stability, not provider quality

Same providers, same request cycle, same code path:

| Field | Keyed by | Stable? | Accuracy (n=25) |
|---|---|---|---|
| Aircraft type | ICAO24 — the airframe | never changes | **100%** |
| Route | callsign — the flight number | changes every leg, every day | **32%** |

`AA578` was DFW-JFK in reality, PHL-CMH in adsbdb, and PHX-SEA in hexdb. All
three are real AA578s from different days. **Callsign to route is not a
function**, and adsbdb/hexdb each store exactly one answer.

No free callsign-keyed database can fix this. The fix is to key on something
that identifies the *leg*: a schedule, joined by flight number and time.

### The airline field has a separate, unfixable-by-data problem

`EDV5075` is Endeavor Air by callsign and **Delta** on the ticket. Measured in
the same sample: `RPA -> AA` three times and `RPA -> DL` twice — the same
operator prefix mapping to two different marketing carriers. A static
callsign-prefix table (`utils/AirlineNames.h`) structurally cannot express this.
Only a source that carries both codes can.

## Decisions

1. **Positions: adsb.lol.** Keyless, no ToS problem, no rate limit observed
   (~150 requests in one session, zero throttling). Returns registration (`r`),
   ICAO type (`t`), and precomputed distance (`dst`) / bearing (`dir`) inline.
2. **Routes: airport schedules from AeroDataBox for KJFK / KLGA / KEWR / KBOS**,
   joined to the ADS-B callsign by (operator prefix, trailing digits).
   **KBOS is not a local airport — it is included because the Boston corridor
   overflies Long Island.** Measured: it lifts airline coverage from 93% to 100%
   at a 10 km radius, and from 92% to 96% at 40 km. Six of eleven airline misses
   in the sample were BOS-bound.
3. **ETA: computed, not purchased.** Two-segment physics model, cross-checked
   against the scheduled arrival.
4. **A server sits in the middle** and does all fetching, joining, filtering,
   conversion, and ETA math. Device renders.
5. **adsb.lol-direct stays compiled into the firmware as a keyless fallback**, so
   a wall with no server and no keys still works.

### Expected accuracy

```
                                          correct   blank   SILENTLY WRONG
adsbdb + hexdb (today)                        32%      0%             52%
adsb.lol alone                                38%     54%              8%
adsb.lol + 4-board schedules  (target)    ~90-94%   ~5-9%             ~3%
```

Target is **radius-dependent**, since board coverage falls off with distance:

```
  radius   coverage x join x accuracy  =  correct
   10 km      100%     97%      97%        ~94%
   40 km       96%     97%      97%        ~90%
   80 km       94%     97%      97%        ~88%
```

All three terms **measured** — coverage above, join and accuracy under
"Validation" below. Default radius is 10 km (`config/UserConfiguration.h:11`).

Roughly a **17x reduction in wrong destinations.** The design goal is not
maximum correctness — it is that the wall should **never state a confident
falsehood**. Blank beats wrong on a 64px panel.

## Architecture (option C)

```
  Cloudflare Worker                                    ESP32-S3
  ────────────────────                                 ────────────
  cron  */6h ──> AeroDataBox FIDS (KJFK/KLGA/KEWR/KBOS)
                   └─> KV: schedule table

  GET /v1/flights ─> adsb.lol positions               GET /v1/flights
                     join schedules by suffix    <────  (30s, ONE call)
                     plausibility filter
                     ETA model                   ────>  ~2 KB JSON
                     units + airline names              render
                                                 
  (server unreachable) ..............................> adsb.lol direct
                                                       + physics ETA
```

### Why a server, concretely

Today one fetch cycle can open `1 + 2*maxFlights = 17` TLS connections. That
arithmetic is the reason `kEnrichBudgetMs` exists, and it is documented in
`core/FlightDataFetcher.h:24` as the cause of a real coredump — `loopTask`
parked in `start_ssl_client(hostname="hexdb.io")` until the 120s loop watchdog
rebooted the wall.

**One server means one connection per cycle, with keep-alive.** The failure mode
is eliminated by construction rather than bounded by a budget. Keep
`kEnrichBudgetMs` as a guard; it should never fire again.

## Server

### Contract

```
GET /v1/flights?lat=&lon=&radius_km=&max=8&units=imperial
                &exclude_ground=1&hide_cargo=0&min_alt_ft=&max_alt_ft=
```

```json
{
  "ok": true,
  "ts": 1787182176,
  "stale": false,
  "flights": [
    { "cs":"EDV5075", "flt":"DL5075", "al":"Delta", "reg":"N914XJ",
      "ac":"CRJ9", "from":"CVG", "to":"LGA",
      "alt":8025, "spd":314, "hdg":230, "vs":1664,
      "dst":12.4, "brg":291,
      "eta_min":18, "eta_text":"~20m", "eta_src":"physics" }
  ]
}
```

- Already sorted nearest-first and capped to `max`. Device does no sorting.
- Already in display units. Device does no conversion.
- `al` is a resolved display name. Device needs no airline table.
- `ok:false` means the fetch failed — device MUST keep its previous flights and
  not blank the display. This preserves the existing `fetchFlights(ok)` contract.
- `stale:true` means schedules or positions were served from cache after a
  provider failure. Rendered normally; surfaced in the web UI only.
- Absent fields mean "unknown" and MUST render as blank, never as a zero or a
  guess. `to` absent = no destination known = no ETA.

### Schedule refresh (cron, every 6h) — AeroDataBox

Provider: **AeroDataBox**, FIDS ("departures and arrivals by airport ICAO
code"). One call returns both directions; pass `withLeg=true` so departing
flights carry their arrival time at destination. Relative time ranges are
supported, so the cron can ask for "from 2h ago, next 12h" without computing
absolute windows.

Pull arrivals + departures for **KJFK, KLGA, KEWR, KBOS** into KV, keyed by
(operator prefix, trailing digits):

```
5075 -> { carrier:"DL", orig:"CVG", dest:"LGA",
          sched_dep, sched_arr, dest_lat, dest_lon }
```

~4,300 rows/day across the four airports (measured: KJFK ~670 arrivals/day,
KLGA ~570, KEWR ~660, plus departures). Decoupled from device requests, so
device latency never includes a provider call. A failed refresh keeps the
previous table and sets `stale` — routes keep resolving from the last good pull.

**Cost.** 4 airports x 4 refreshes/day = 16 calls/day ~ 480/month, plus a second
call per airport if the 12h window cap requires it (~960/month worst case).
AeroDataBox prices per call by tier: T1=1 unit, T2=2, T3=6. Flight-status is
documented as T2; **the FIDS tier is unconfirmed.** Even at T3 that is
2,880-5,760 units/month, inside the **$5/mo Pro tier (6,000 units)**. The free
Basic tier (600 units) is enough to verify the tier and the response shape
before subscribing, but not to run on.

Note this cost is **flat in traffic volume** — it does not scale with how busy
the sky is, which is what makes a JFK-adjacent wall cheap rather than expensive.

**Two things to verify on the free tier before building:**

1. **The FIDS tier** (1, 2, 3, or 4 units per call). Decides $5 vs $15.
2. **Whether FIDS rows carry the ICAO callsign**, not just the IATA flight
   number. AeroDataBox's flight-status endpoint accepts lookup *by callsign*, so
   the data exists somewhere in their model. If FIDS exposes it, join on exact
   callsign equality and **delete the entire composite-key and operator-mapping
   design below** — no suffix parsing, no collision handling, and the marketing
   carrier comes straight off the row. That is a strictly better design; the
   composite key is the fallback for when it is not available.

### Route resolution

```
key = (operator prefix, TRAILING digits of the callsign)   EDV5075 -> (EDV, 5075)
hit = schedule.lookup(key, now)                            -> DL5075: CVG->LGA
```

**The key MUST be composite. A bare numeric suffix is not safe.** Measured on 409
airline callsigns within 250 nm of JFK:

```
bare numeric suffix          : 27 collision groups  (7.1% of keys)
  e.g. DAL846/JBU846, AAL1075/JBU1075, AAL300/SWA300, FDX1347/UAL1347
(operator prefix, suffix)    :  0 collisions across 382 keys
```

Two airlines using the same flight number is entirely normal, so suffix-alone
silently picks whichever row it finds first. Adding the operator prefix resolved
26 of 27 groups; requiring the suffix to be a **trailing** digit run (not the
first digit run anywhere in the string) resolved the last one.

The operator prefix also constrains which carrier a row may belong to. Mainline
prefixes map 1:1 to their own IATA code (`DAL`->`DL`, `JBU`->`B6`, `SWA`->`WN`).
Regional prefixes map to a small set (`EDV`->{DL}, `RPA`->{AA,DL,UA}). Require
the schedule row's carrier to be in that set; disambiguate any residual tie by
scheduled time, then by geometry.

Measured **93% join rate** (382/409) at scale. Two failure modes found, both must
be handled:

- **IATA codes containing digits.** JetBlue is `B6`, so `JBU1532` -> `B61532`.
  Match must be `flight_number.endsWith(suffix)`, NOT equality on parsed digits.
  A naive parse scored all six JetBlue flights as failures.
- **Alphanumeric callsigns.** `BAW2LJ` -> `BA1228`, and likewise `AFR53X`,
  `EIN12G`, `VIR74W`, `QTR1X`, `LOT3PK`. The callsign bears no relation to the
  flight number, so no join is possible from ADS-B alone. **7% of airline
  callsigns**, concentrated in international carriers — which matters at JFK
  specifically. These MUST be rejected (callsign must end in digits) rather than
  fuzzy-matched, and render blank.

  Rate depends on which population you measure. Among aircraft *airborne* within
  250 nm of JFK, 7% are unjoinable. Among actual *arrivals at JFK/LGA/EWR* —
  the only flights a schedule join applies to — only 3% are (n=5,071).
  **Use 97% for the join term**; the wider population's shortfall is already
  captured by the 92% coverage term. Do not multiply both.

The join also fixes the airline field: the marketing carrier comes from the
schedule row (`DL` -> "Delta"), never from the callsign prefix.

**Plausibility filter — reject, do not display, if:**
- the aircraft is more than 300 km off the corridor between claimed origin and
  destination (caught 6/17 bad routes at 0 false positives), or
- the aircraft is descending below 15,000 ft with a claimed destination more
  than 250 km away.

Rejected routes render blank. This converts wrong into unknown, which is the
whole point.

**Fallback when no schedule row matches:** `adsb.lol /api/0/route/{callsign}`,
which returns the full rotation with airport coordinates. Use the geometrically
best-fitting leg. Coverage ~55%, and of what it returns ~15% is impossible and
gets filtered.

### ETA model

```
d  = great-circle nm from aircraft to destination
gs = groundspeed kt

d > 60nm :  eta = (d - 60)/gs * 60 + 18      // enroute at current speed
d <= 60nm:  eta = d / 200 * 60               // terminal at nominal 200kt
```

The terminal segment exists because a naive `d/gs` is optimistic by a roughly
**constant ~10 minutes** at any range above the terminal area — the aircraft
always owes the same deceleration. That is 10% error on a transatlantic and
**50% at 60 nm out**, which is exactly where a viewer is watching.

```
phase                d(nm)  gs(kt)   naive    2-seg    diff
cruise, 800nm out      800     470  102.1m   112.5m  +10.3m
cruise, 200nm out      200     450   26.7m    36.7m  +10.0m
top of descent         120     400   18.0m    27.0m   +9.0m
descending              60     300   12.0m    18.0m   +6.0m
approach                25     220    6.8m     7.5m   +0.7m
final                    8     150    3.2m     2.4m   -0.8m
```

The halves meet continuously at 18 minutes, and converge with naive on short
final where current groundspeed genuinely is representative.

**Cross-check against the schedule.** A static daily schedule has no delay data,
so its arrival time is wrong for any delayed flight. On disagreement, **trust
the physics** and set `eta_src:"physics"`. The two sources fail in uncorrelated
ways, so a large disagreement is itself a signal — log it, do not display it.

Not modeled, and not modelable from this data: vectoring, holds, runway changes,
taxi-in. Accept ~5 min enroute error.

### Display rules

Note these are two independent thresholds, and they are not the same number:
**60 nm** is where the *model* switches from current groundspeed to the nominal
terminal profile. **30 nm** is where the *display* stops showing a number at
all. Inside 30 nm the model still produces a value; we decline to show it.

- Round to 5 min under an hour, 10 min over. Always prefix `~`.
- Inside 30 nm of destination, show `LANDING` instead of a number.
- No destination, or route rejected by the filter: show nothing.

**Rounding is applied by whoever computes the ETA.** In server mode the server
rounds and emits `eta_text`; the device renders it verbatim. In fallback mode
the device computes and rounds using the same rules. `eta_min` is always the
unrounded value, for the web UI and for logging.

Chosen because the model does not support finer precision, and `LANDING` is more
informative on a 64px panel than a number that is wrong by 40%.

## Firmware

### New

- **`adapters/FlightWallServerFetcher`** — one GET, small parse, fills
  `FlightInfo` directly. Becomes a `PositionSource`.
- **`adapters/AdsbLolFetcher`** — keyless fallback. Fills `StateVector`
  including `aircraft_type` and registration from `t` / `r`, and
  `distance_km` / `bearing_deg` from `dst` / `dir`.

### Changed

- `models/FlightInfo.h`: add `eta_min` (double, NAN = unknown) and `eta_text`.
- `models/StateVector.h`: add `registration`.
- Emitter category: adsb.lol encodes it as a string (`"A7"` = rotorcraft), not
  the OpenSky integer. The `category == 8` helicopter check must handle both.

### Removed from the hot path

adsbdb and hexdb per-flight lookups, imperial/SI conversion, radius filtering,
sorting, `AirlineNames.h` lookup, and the ETA math — all server-side when a
server is configured. The adapters stay for fallback mode.

### Fallback behavior

`positionSource = FlightWallServer` uses the server. On connection failure the
device drops to adsb.lol-direct with physics ETA and reduced route accuracy
(~38% correct / 8% wrong). It never blanks the display on a failed fetch.

**A wall with no server and no API keys must work.** That is the default for
anyone who flashes this firmware without running infrastructure.

## Bugs to fix regardless

1. **`adapters/AdsbdbFetcher.cpp:104` — multi-leg routes resolve to
   origin == destination.** The parse takes the first and *last* segment, so the
   rotation `KLAX-KDFW-KLAX` renders as **"LAX -> LAX"**. 27% of routes sampled
   were multi-leg. Fix by selecting the leg the aircraft is actually on.
   *Note: leg selection is a display-sanity fix, not an accuracy fix — measured
   at 35% correct vs 38% for naive first/last, i.e. within noise at n=37.*

2. **`core/FlightDataFetcher.cpp:57` — the enrichment cache is keyed by ICAO24
   (the airframe), but the route belongs to the leg.** A regional jet flying
   five legs a day keeps its first route for the whole TTL.
   `docs/data-sources.md` currently advises *raising* `enrichmentCacheSeconds`
   because "route doesn't change mid-flight" — true mid-flight, false across
   legs. **Correct that doc.** Cache route by (callsign, leg), not by airframe.

3. **`adapters/FlightRadar24Fetcher.cpp` — `has_inline_enrichment` suppresses
   fallback.** It is set when FR24 supplies *any* of route/type/airline, which
   skips the adsbdb lookup even when only the type came through, so the route is
   never filled. Gate on route presence specifically.

## Rejected alternatives

- **FR24 `clickhandler`** (the endpoint carrying real ETA): now returns 403
  behind a Cloudflare JS challenge. Not usable, do not retry.
- **FR24 `feed.js` scrape**: began returning empty bodies after roughly 15
  requests in an hour during this investigation — the documented rate-limiting,
  observed live. Plus the standing ToS problem.
- **Official FR24 API**: `/live/flight-positions/full` carries `eta`,
  `painted_as`, and `operating_as` — genuinely the best data available — but is
  billed **per returned flight at 8 credits**, so continuous area polling costs
  ~$829/mo at a 5-minute cadence and ~$8,294/mo at the current 30s cadence.
  `flight-summary/light` is 1 credit and carries route + `painted_as` but **no
  ETA**; viable at ~$9/mo if route accuracy alone is ever worth paying for.
- **Per-flight lookups on any provider** (AeroDataBox flight-status, AirLabs,
  FR24 official): all workable, all priced per flight, so cost scales with how
  busy the sky is. The airport-board approach is flat in traffic volume and
  covers the same aircraft. **AeroDataBox chosen** over AirLabs because AirLabs'
  free key caps 50 results per call — JFK alone runs ~50 arrivals/hour, so a 12h
  window would need heavy pagination — and its paid tier jumps to $49/mo against
  AeroDataBox's $5.
- **Bundled airport coordinate table (~18 KB flash)**: unnecessary. adsb.lol and
  the schedule rows both carry destination coordinates.

## Measured vs assumed

**Measured on live data:**
- adsbdb destination accuracy 32%, silently wrong 52% (n=25)
- adsb.lol 38% correct / 49% blank / 8% silently wrong (n=37)
- Aircraft type via ICAO24: 100% correct (n=25)
- Board coverage of **airline** traffic, by radius (n=101 pooled, 4 boards
  incl. KBOS): 100% at 10-20 km, 98% at 30 km, 96% at 40 km, 94% at 80 km.
  Without KBOS: 93% / 95% / 92% / 87%. GA is excluded — it is never in any
  schedule and correctly renders route-blank.
- All traffic including GA at 10 km: 87%. The gap is N-numbered aircraft, mostly
  out of Farmingdale (KFRG).
- Callsign to flight-number join: **93%** (n=409, within 250 nm)
- Flight-number collisions: 7.1% on bare suffix, **0% on (operator, suffix)**
  (n=382 keys)
- Sky composition within 60 nm: 75% airline, 18% GA, 5% no callsign (n=221)

**Assumed, and worth validating before building on it:**
- ~~Schedule data is 93-99% accurate~~ **VALIDATED 2026-08-19 — see below.**
- Flight-number keys are unique within a day. **Partly false** — measured 1.2%
  of keys at KLGA/KEWR flew from two different origins in the same day (0 at
  KJFK). Scheduled-time disambiguation is therefore REQUIRED, not optional.

All samples are one metro, one evening. Treat 38% vs 32% as "about the same";
the 6x gap in the silently-wrong bucket is too large to be sampling noise.

## Implementation sequencing

This spec covers two deliverables that should become **two separate plans**:

1. **Server** (Cloudflare Worker) — schedule cron, route join, plausibility
   filter, ETA model, `/v1/flights`. Independently testable against recorded
   fixtures; no hardware needed.
2. **Firmware** — the two new adapters, model fields, and the three bug fixes.
   Depends on the contract in this document, not on the server being finished.

The three bugs under "Bugs to fix regardless" are independent of both and can
land first.

Before either: **validate the schedule-accuracy assumption** against one day of
real JFK data. It is the single soft number the ~87% target rests on.

## Validation: schedule stability (2026-08-19)

The core assumption — *a published schedule tells you the leg a flight number is
actually flying today* — was tested using authenticated OpenSky historical
arrivals for KJFK / KLGA / KEWR: **5,401 arrival records across three days**
(Tue 2026-08-18, Mon 2026-08-17, Tue 2026-08-11).

Method: build `(operator prefix, trailing digits) -> origin airport` per airport
per day, then ask how often the same key keeps the same origin across days.
Same-weekday comparison (D-1 vs D-8) isolates day-of-week schedule variation.

```
                                    shared keys   same origin   differs
high-confidence records only (departureAirportCandidatesCount == 1)
  KJFK  Tue D-1 vs Tue D-8                 101      100   99%         1
  KJFK  Tue D-1 vs Mon D-2                 103      103  100%         0
  KLGA  Tue D-1 vs Tue D-8                  84       84  100%         0
  KLGA  Tue D-1 vs Mon D-2                 104      103   99%         1
  KEWR  Tue D-1 vs Tue D-8                  81       80   99%         1
  KEWR  Tue D-1 vs Mon D-2                 101      100   99%         1

all records (includes OpenSky's own origin-estimation error)
  KJFK  Tue D-1 vs Tue D-8                 397      385   97%        12
  KLGA  Tue D-1 vs Tue D-8                 388      366   94%        22
  KEWR  Tue D-1 vs Tue D-8                 363      346   95%        17
```

**Result: 94-100% stable, and 99-100% on high-confidence records.** The assumed
93-99% band holds. The spread between the two blocks is OpenSky's own
`estDepartureAirport` noise, not schedule instability — one differing key
resolved to `SC98`, which is not a real airline origin.

Also measured on the same 5,401 records:

- **97% of airline callsigns end in digits** and are joinable. This supersedes
  the 93% figure taken from a 250 nm airborne sample: that population includes
  overflights and international traffic bound elsewhere, which the 92% coverage
  term already excludes. **For flights that actually touch JFK/LGA/EWR — the only
  ones a schedule join applies to — the rate is 97%.**
- **94% of arrivals are airline-format callsigns** (vs 75% of *airborne* aircraft
  near JFK, which includes far more GA).
- **Same-day key ambiguity: 0 keys at KJFK, 6 at KLGA, 6 at KEWR** (~1.2%) had
  two different origins in one day — shuttle rotations reusing a number. These
  MUST be disambiguated by scheduled time.

Revised end-to-end target: 92% coverage x 97% join = **89% schedule match**, at
97% schedule accuracy -> **~86% correct / ~11% blank / ~3% wrong.**

Reproduce with `flights/arrival?airport=&begin=&end=` against an authenticated
OpenSky client; anonymous access is capped at a 24h window and returns ~21 KJFK
records, far too sparse to use.

## Out of scope

Flights mode (AeroAPI), display layout beyond the ETA field, the existing
OpenSky and FR24 adapters (kept, not removed), and multi-device server auth.
