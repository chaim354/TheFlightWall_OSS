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
2. **Routes: daily airport schedules for KJFK / KLGA / KEWR**, joined to the
   ADS-B callsign by numeric suffix.
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
adsb.lol + JFK/LGA/EWR schedules  (target)   ~83%    ~14%             ~3%
```

Target derived as: 92% coverage x 93% join = 86% schedule match, at an assumed
97% schedule accuracy.

Roughly a **17x reduction in wrong destinations.** The design goal is not
maximum correctness — it is that the wall should **never state a confident
falsehood**. Blank beats wrong on a 64px panel.

## Architecture (option C)

```
  Cloudflare Worker                                    ESP32-S3
  ────────────────────                                 ────────────
  cron  */6h ──> airport schedules (KJFK/KLGA/KEWR)
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

### Schedule refresh (cron, every 6h)

Pull arrivals + departures for KJFK, KLGA, KEWR into KV, keyed by numeric
suffix:

```
5075 -> { carrier:"DL", orig:"CVG", dest:"LGA",
          sched_dep, sched_arr, dest_lat, dest_lon }
```

~3,200 rows/day. Decoupled from device requests, so device latency never
includes a provider call. A failed refresh keeps the previous table and sets
`stale` — routes keep resolving from the last good pull.

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

  An earlier small sample (n=37, mostly US domestic) put this at 3% and the join
  rate at 97%. The 250 nm sample is more representative for a JFK-adjacent wall.
  **Use 93%.**

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
- **AeroDataBox / AirLabs per-flight lookups**: ~$5-15/mo, workable, but the
  airport-board approach is cheaper and covers the same traffic.
- **Bundled airport coordinate table (~18 KB flash)**: unnecessary. adsb.lol and
  the schedule rows both carry destination coordinates.

## Measured vs assumed

**Measured on live data:**
- adsbdb destination accuracy 32%, silently wrong 52% (n=25)
- adsb.lol 38% correct / 49% blank / 8% silently wrong (n=37)
- Aircraft type via ICAO24: 100% correct (n=25)
- JFK/LGA/EWR covers 92% of local airline traffic (n=25)
- Callsign to flight-number join: **93%** (n=409, within 250 nm)
- Flight-number collisions: 7.1% on bare suffix, **0% on (operator, suffix)**
  (n=382 keys)
- Sky composition within 60 nm: 75% airline, 18% GA, 5% no callsign (n=221)

**Assumed, and worth validating before building on it:**
- Schedule data is 93-99% accurate for the live leg. **STILL UNTESTED.** A
  validation attempt on 2026-08-19 was blocked: every schedule provider requires
  an account, anonymous OpenSky serves only a 24h window (and returned just 21
  KJFK arrivals, far too sparse), and the Port Authority site renders its board
  client-side. The ~83% end-to-end figure depends entirely on this number.
  **Resolve before building the server.** Needs either OpenSky credentials
  (unlocks historical arrivals for a day-over-day route-stability test) or a
  free-tier schedule key.

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

## Out of scope

Flights mode (AeroAPI), display layout beyond the ETA field, the existing
OpenSky and FR24 adapters (kept, not removed), and multi-device server auth.
