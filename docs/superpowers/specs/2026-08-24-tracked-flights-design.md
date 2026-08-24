# Track a specific flight, anywhere — design

**Dated record.** Written 2026-08-24 against `claude/tracked-flights`, branched
from `main` at `8640977`.

## Problem

The wall shows what is overhead. It cannot answer "where is the flight my
brother is on", which is the question people actually ask a flight display.

The prompt for this was budget: quiet hours cut AeroDataBox spend from 12
refreshes a day to 9, and the question was whether the freed allowance could buy
something. Measured 2026-08-24 against the live deployment:

| | |
|---|---|
| Refreshes/day | 9 (00:00, 02:00, 04:00 suppressed; one forced at ~06:0x) |
| Calls per refresh | 4 -- one per board, `direction=Both`, not one per direction |
| **Calls/day** | **36** |
| Units/month | ~2,160 of the 6,000 tier (2 units/call) |
| **Spare** | **~3,840 units = ~1,920 calls = ~64/day** |

The Cloudflare Worker contributes nothing: `wrangler deployments list` returns
`This Worker does not exist on your account` (code 10007). Its six-hourly cron
is hypothetical until someone deploys it.

## What already exists (do not rebuild)

Checked before designing, because most of the obvious surface is already here:

- **A "Flights" tracking mode on the device.** `Settings.trackedFlights` holds
  idents/callsigns/tails, `SerialConsole` has `mode <area|flights>`, and
  `FlightDataFetcher::fetchFlightsMode` iterates the list. It resolves through
  `getEnriched()` -- the enrichment sources -- not AeroDataBox, and the wall
  device has `aeroApiKeySet=false` with `enrichmentSource=adsbdb`, which
  HANDOFF records as frequently wrong for routes.
- **A web UI textarea** for `trackedFlights` (`data/index.html:154`), already
  round-tripping to settings.
- **`modeS` on every AeroDataBox board row.** `aerodatabox.ts:18` documents the
  payload as `aircraft: { reg, modeS, model }`. `modeS` IS the ICAO24 hex that
  OpenSky keys on, and **the parser currently discards it** -- `ScheduleRow` has
  no `reg` or `modeS` field.

That last point is the cheapest win available: for any flight touching KJFK,
KLGA, KEWR or KBOS the hex is already paid for, and capturing it is a parser
change costing zero additional API calls.

**This design does NOT extend device Flights mode.** It is server-side, and the
existing mode is left alone. Deciding whether the two should converge is
deliberately deferred -- see "Not doing".

## Decisions taken

| Question | Decision |
|---|---|
| What "track" means | **Follow a flight anywhere in the world**, not just when overhead |
| Entry granularity | **One flight number + one specific date.** A journey, not a recurring subscription |
| Aircraft identity | **AeroDataBox resolves flight -> `modeS` hex**; identity is per-journey, not permanent |
| Live position | **OpenSky by `icao24`** -- free, global, and the key already exists |
| No ADS-B coverage | **Dead-reckon along the route**, explicitly labelled as estimated |
| Where it runs | **Server-side.** Keys stay off a device whose radio the panel degrades |
| Display | **Pinned to the top of the rotation, with a visual marker** |
| Configuration | **New server endpoint** `/v1/tracked`, **unauthenticated for now** |

## Lifecycle

An entry is `{ number, date }`. The state machine is a pure function over
`(entry, nowMs)` returning the next state and the action to take.

| State | Trigger | Action | Cost |
|---|---|---|---|
| `pending` | added; departure > 3h away | none | zero |
| `resolving` | ~3h before scheduled departure | AeroDataBox `/flights/number/{n}/{date}` -> `modeS`, `reg`, route, times | **1 call** |
| `resolved` | hex known, not yet airborne | re-resolve ONCE at scheduled departure | **1 call** |
| `airborne` | between departure and arrival | poll OpenSky by `icao24` | OpenSky only |
| `landed` | arrival time passed, or OpenSky reports on-ground | none | zero |
| `unresolved` | AeroDataBox cannot identify the flight (see below) | none -- terminal, no retry | zero |
| `expired` | landed + 2h, `unresolved` + 1 day, or date more than 1 day past | drop from store | -- |

**Why resolve at ~3h, and again at departure.** Aircraft assignment is not
reliable far ahead, so resolving days early buys a hex that may not be the
aircraft that flies. Re-resolving once at departure catches a tail swap, which
is the common way "the hex I am following is not that flight any more" happens.
Two calls per journey is the deliberate price of not silently following the
wrong aeroplane.

**Why entries self-expire.** A forgotten entry must not be able to spend budget
forever. Expiry is what makes an unauthenticated endpoint survivable.

Budget: **~2 AeroDataBox calls per tracked journey.** A dozen concurrent
journeys is noise against 64/day.

### When resolution fails

A flight number that AeroDataBox does not recognise, or that is not operating on
the given date, is the ordinary case -- typos and cancelled flights both land
here -- so it needs a defined state rather than a retry loop.

| Outcome | Handling |
|---|---|
| Flight not found / not operating that date | -> `unresolved`, **no retry**, entry kept and surfaced with a reason on `GET /v1/tracked` |
| Transport error (timeout, 5xx, rate limit) | Retry with the same escalating-backoff discipline `ServerBackoff.h` already uses; at most 3 attempts per window, then `unresolved` |
| Resolved, but no `modeS` in the payload | -> `unresolved` with a distinct reason. It is not a failure of the request, and conflating the two would hide the "to verify" risk below |

`unresolved` is terminal for that entry and expires on the normal schedule. The
distinction matters because a silent retry loop against an endpoint that will
never succeed is precisely how an unauthenticated feature drains a quota: a
single typo'd flight number must cost at most 3 calls, not 3 per hour forever.

The entry is never deleted automatically on failure. A user who typed `BA1811`
needs to see it sitting there with "not operating 2026-09-14" against it, rather
than have it vanish and wonder whether it was ever added.

## OpenSky is the real ceiling

AeroDataBox stops being the constraint the moment the hex is known; OpenSky
takes over. One 8-hour flight polled every 60s is ~480 requests against an
authenticated allowance of roughly 4,000/day -- so about 4-6 concurrent
long-hauls before it strains, not the dozen AeroDataBox would allow.

The cadence above assumes **1 credit per single-`icao24` query, which is
unverified.** If it costs more, the cadence drops rather than the feature
changing shape. Measure before tuning: see "To verify first".

The server needs OpenSky credentials it does not currently have --
`OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` in `config/deploy.yml`'s secret
block, alongside `AERODATABOX_KEY`. (The device holds an `openSkyClientId` but
`openSkyClientSecretSet=false`; the server's are separate.)

## Components

Six units, each with one responsibility. The two that carry the real logic are
pure, matching the shape that worked for `quietHours.ts` and `FetchCadence.h`.

| Unit | Responsibility | Tested as |
|---|---|---|
| `src/tracked/lifecycle.ts` | `(entry, nowMs) -> next state + action` | pure, no I/O |
| `src/tracked/deadReckon.ts` | Great-circle interpolation from route + elapsed | pure |
| `src/tracked/store.ts` | Persist entries in the existing schedule volume | fixture-backed |
| `src/tracked/resolve.ts` | AeroDataBox by-number -> hex, reg, route, times | mocked fetch |
| `src/tracked/opensky.ts` | OpenSky by `icao24` -> position | mocked fetch |
| `/v1/tracked` routes | GET / POST / DELETE + guards | integration |

Serving: tracked cards are merged into `/v1/flights` ahead of the area results,
carrying `pin: true`. The device sorts pinned first and renders the marker.

## The unauthenticated endpoint, and what bounds it

`flightwall.tinkerex.com` is public. An open write endpoint there means anyone
who finds the URL can add entries -- spending AeroDataBox and OpenSky quota, and
reading which flights (and so which people) are being followed. **The maintainer
chose to ship it open for now**, and this records that as a decision, not an
oversight.

Because there is no auth, the guards below are load-bearing rather than
defensive niceties. They convert "unbounded quota drain" into "bounded":

- **At most 20 entries** in the store. Further POSTs are rejected.
- **Date within `today-1 .. today+14`.** Rejects both absurd future entries and
  backfill attempts.
- **A daily resolution ceiling** of **50** AeroDataBox calls/day for this
  feature. Past it, resolution stops until the next day and says so in the log
  rather than silently degrading. 50 rather than a rounder number because the
  entry cap and the ceiling have to be consistent: 20 entries x 2 calls each is
  40 in the worst case where every entry resolves on the same day, and a ceiling
  below that would deadlock a legitimately full store. In normal use only the
  handful of journeys flying that day resolve, so this binds under abuse and
  essentially never otherwise. It still leaves ~14 calls/day of the measured
  spare untouched.
- **Automatic expiry**, per the lifecycle above.

Adding a shared-secret header later is a one-line middleware over these routes;
the guards stay useful either way. That seam is deliberate.

## Dead-reckoning must never look measured

Community ADS-B has large oceanic gaps, so a transatlantic flight will spend
much of its journey with no fix. The decision is to interpolate along the
great-circle route from scheduled departure, elapsed time and the route
endpoints.

This invents a position. The single non-negotiable constraint: **it must be
distinguishable from a real one at every layer.** Concretely, an estimated card
carries `pos_src: "estimated"` (alongside the existing `eta_src` convention),
and the panel renders the marker differently for estimated versus live.

The reason is the failure mode this codebase already names: a plausible-looking
wrong value is worse than a visibly absent one. `clearStaleFlights` exists
because of it, and `FlightWallServerFetcher` propagates `ok:false` rather than
render a partial array for the same reason. A dead-reckoned position that reads
as a fix would be exactly that mistake, on the one card the user is watching
most closely.

## Device changes

Small, and confined:

- New `pin` and `pos_src` fields parsed in `FlightWallServerFetcher`.
- Pinned flights sorted first, ahead of the nearest-first ordering.
- A marker in `Hub75Display`, with a distinct treatment for `pos_src:
  "estimated"`.

No new device credentials, no new device network calls. The device stays dumb,
which is the point of putting this server-side on a radio the HUB75 panel is
measurably degrading (HANDOFF 1).

## To verify first (both are assumptions, not facts)

1. **The AeroDataBox by-number payload.** `modeS` is confirmed present on the
   *board* endpoint we already parse. The `/flights/number/{n}/{date}` endpoint
   is expected to carry it too, but its payload has not been seen. First
   implementation step is one real call captured as a fixture. If `modeS` is
   absent there, the fallback is `reg` -> hex via a registration lookup, which
   changes cost and must be re-costed before building further.
2. **OpenSky credit accounting** for a single-`icao24` query, which sets the
   poll cadence.

Neither blocks the pure units (`lifecycle`, `deadReckon`), so implementation can
start there while these are measured.

## Not doing

- **Converging with device Flights mode.** It exists, it works differently, and
  merging the two is a separate decision with its own migration question.
- **Recurring entries** ("BA181 every Monday"). The chosen granularity is one
  journey. Recurrence can be built on top later if wanted.
- **Auth on the write endpoint** -- explicitly deferred above.
- **Deploying the Worker.** Out of scope, and it would add 16 calls/day with one
  tick landing inside the quiet window.
- **Any change to the area view's behaviour** beyond pinning.

## Risks

| Risk | Mitigation |
|---|---|
| Open endpoint drains quota or leaks who is flying | Entry cap, date window, daily resolution ceiling, auto-expiry. Accepted knowingly; auth seam left clean |
| Aircraft swaps after resolution | Re-resolve once at scheduled departure |
| Dead-reckoned position mistaken for a fix | `pos_src: "estimated"` end to end, distinct panel marker |
| OpenSky quota exhausted by concurrent long-hauls | Cadence is configurable; measure credits before tuning |
| By-number endpoint lacks `modeS` | Verified first, before anything depends on it |

## Success criteria

- Adding `{number, date}` costs nothing until ~3h before departure.
- A tracked flight appears pinned, with a marker, whenever it is airborne.
- Over an ADS-B gap the card stays visible and is visibly marked estimated.
- The entry disappears on its own after landing; no manual cleanup.
- Total AeroDataBox spend stays under the 6,000/month tier with margin.
- Both firmware envs build, host tests pass, server suite passes.
