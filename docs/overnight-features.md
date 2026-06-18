# Overnight feature work — design decisions (for review)

Autonomous session against the overnight chore list. Everything is **opt-in and
reversible** (new behavior defaults OFF or matches current behavior), compile- and
host-test-verified only — **nothing was run on the device** (it's mid-migration).
Visual screens need your eyes on hardware before final sign-off.

## Chores → how I'm implementing them

### 1. Private / GA + cargo handling (HANDOFF §5 plan)
The prior attempt was reverted for mislabeling un-enriched airliners (DAL/AAL) as
"private". Fix: classify by a **positive signal**, never by "enrichment failed".
- **Private = the callsign is an aircraft registration**, decided by a new host-tested
  `isTailNumber()`: it is NOT an airline-format callsign (fails `parseAirlineIcao`,
  i.e. not 3 letters + a digit) AND matches a registration shape (US `N`+digit, or
  contains a `-`, or short letters+digits). DAL123/AAL2960 parse as airlines → never
  private. N172SP → private.
- **Two-pass fill** in Area mode: pass 1 = airliners (have `operator_icao`, not
  private) fill the slots nearest-first; pass 2 = GA/private fill leftovers **only if
  `showGeneralAviation` is ON (default OFF)** — last priority, so airliners always win.
- **Cargo = a known freight operator** (curated ICAO set: FDX, UPS, GTI, GEC, CLX,
  CKS, CAO, BOX, ABW, MPH, …). Non-destructive: cargo airliners still show normally
  with a cargo indicator; a `hideCargo` setting (default OFF) can filter them out.
- New `FlightInfo` flags: `is_private`, `is_cargo` (`is_helicopter` already exists).
- New settings: `showGeneralAviation` (false), `hideCargo` (false).

### 2. Logo priority (Hub75Display)
Single selection order, replacing the current `is_helicopter ? "_HELI" : operator_icao`:
1. `is_helicopter` → `_HELI` (so an N-number heli shows the heli icon, not _PRIVATE)
2. `is_private` → `_PRIVATE`
3. `operator_icao` tile if it exists → real/badge logo
4. else `is_cargo` → `_CARGO`
5. else generic fallback (existing behavior)

### 3. Cargo airline logos
Generate **brand-colored code badges** (NOT trademarked artwork — policy-safe, like
the existing committed badges) for the cargo ICAO set, via the existing
`tools/gen_starter_logos.py`. Committed. Real logo tiles, if you have them, still drop
in locally and override the badge.

### 4. "No flights" screen
New setting `noFlightsMode`: `Dots` (current "..."), `Clock` (large time + date from
NTP), `FunFact` (rotating airline fun fact), `ClockAndFact` (alternates). Fun facts
live in a small embedded `data`/PROGMEM table (~24 short, verifiable facts) — frugal,
no network. Default stays `Dots` so nothing changes unless you opt in.

### 5. Startup / splash screen
Replace the plain `displayMessage("FlightWall")` boot text with a styled splash
(wordmark + a small plane glyph + version line) shown briefly during init.

## Verification policy this session
- Every task: `pio run -e esp32dev` SUCCESS + host tests (`test_parsers`, `test_lru`,
  and new `test_classify`) ALL PASS.
- **Not device-verified** (you're migrating): the actual look of the splash + no-flights
  screens, and that private/cargo filtering behaves right against live traffic. Flagged
  per item in the morning summary.

## Open questions for you (morning)
- No-flights default: I left it `Dots` (unchanged). Want `Clock` or `ClockAndFact` as
  the default once you've seen them?
- GA opt-in default OFF (airliners-only) — confirm that's the intent.
- Cargo: show-with-indicator (default) vs hide — I defaulted to show.
- Fun-fact content: I'll seed ~24 factual, non-trademark-risky aviation facts; tell me
  if you want a different vibe (airline-specific, jokes, etc.).
