# TheFlightWall Firmware

This is a high-level overview of the firmware that powers TheFlightWall on ESP32.

### What it does
- **Configures itself over the web** — a built-in `WebServer` + single-page UI (served from LittleFS) replaces the mobile app. WiFi, API keys, location, filters, layout, and schedule are all runtime settings persisted on the device.
- **Two tracking modes**:
  - *Area* — a selectable position source (OpenSky `states/all`, Flightradar24, or keyless adsb.lol) filtered by location/radius; live metrics come from the ADS-B state vector. A self-hosted **FlightWall server** is the fourth option and works differently: it returns a display-ready flight list directly — metrics, route, airline name and ETA already resolved, no `StateVector` involved — in one call, and falls back to adsb.lol (state-vector metrics, no route/ETA) if unreachable. See `docs/data-sources.md`.
  - *Flights* — a user list of idents/callsigns/tails looked up directly via AeroAPI; metrics from `last_position`.
- **Enrich flights** (airline / route / aircraft type) from a selectable source: **adsbdb.com** (free, no key — default), **AeroAPI** (paid; usable as primary or as a backup that only fires when adsbdb misses), or off. adsbdb provides the airline name and route, with a hexdb.io fallback; the aircraft field shows the ICAO type code. Results are cached per flight leg to minimize requests.
- **Render** a Mini-style flight card — airline logo tile on the left, then a configurable set of fields (flight #, route, ETA, aircraft, altitude, speed, heading, vertical rate) on the right — on a **HUB75 RGB LED matrix**, cycling up to N flights. ETA only ever appears for FlightWall-server flights with a resolved destination. Logos load from `data/logos/<ICAO>.rgb565`; airlines without a tile get a brand-style code badge.
- **Live web preview** — each frame is composed into an in-RAM `GFXcanvas16` and blitted to the panel; the same buffer is served at `/api/framebuffer` so the web UI mirrors the wall pixel-for-pixel.
- **Brightness scheduling** — day/night brightness using NTP time.
- **WiFi provisioning** — falls back to a `FlightWall-Setup` access point with a captive portal when no credentials are saved.

### Key components
- **src/main.cpp**: Entry point. Loads settings, connects WiFi (or starts setup AP), starts the web server + NTP, then periodically fetches/enriches/renders and applies scheduled brightness.
- **core/Settings**: Runtime, web-editable settings persisted to `/settings.json` on LittleFS; seeded from the compile-time `config/*.h` defaults on first boot.
- **core/WebConfigServer**: HTTP server + REST API (`/api/settings`, `/api/status`, `/api/flights`, `/api/wifiscan`, `/api/restart`) and captive-portal DNS for setup mode.
- **core/FlightDataFetcher**: Orchestrates both tracking modes; applies filters + the maxFlights cap; merges metrics; enriches names.
- **adapters/OpenSkyFetcher**: Queries OpenSky states/all with OAuth; parses and filters by geo. Reads credentials from runtime settings.
- **adapters/AdsbLolFetcher**: Keyless position source backed by adsb.lol; fills aircraft type, registration, and a precomputed distance/bearing inline, so it replaces the per-flight aircraft lookup as well as the state feed. No route — enrichment still runs on top of it.
- **adapters/FlightWallServerFetcher**: One GET to a self-hosted FlightWall server; fills a display-ready `FlightInfo` list directly (route, airline name, ETA already computed), skipping Area-mode enrichment entirely. Falls back to `AdsbLolFetcher` for the cycle if the server is unreachable.
- **adapters/AeroAPIFetcher**: Retrieves flight details + last-position metrics by ident via AeroAPI.
- **adapters/AdsbdbFetcher**: Free enrichment via adsbdb.com (airline name + route by callsign, ICAO aircraft type by ICAO24), with a hexdb.io fallback.
- **adapters/Hub75Display**: Composes each frame into a `GFXcanvas16`, blits to the HUB75 panel, and draws the Mini-style logo + layout card; cycles flights; runtime brightness/color/geometry; exposes the framebuffer for the web preview.
- **config/**: Compile-time *default* values (used to seed runtime Settings on first boot).
- **models/**: Lightweight structs for `StateVector`, `FlightInfo` (now incl. metrics), `AirportInfo`.
- **utils/GeoUtils.h**: Haversine distance and bounding boxes.
- **data/index.html**: The configuration & control web UI.

### Configuration quickstart
- Everything is configured at runtime from the web UI — see the top-level README's "Configuration & Control" section.
- The `config/*.h` files only seed first-boot defaults; the data pin in `config/HardwareConfiguration.h` is the one value not changeable from the web.

### Build
- PlatformIO project: see `platformio.ini` (uses `min_spiffs` partitions + a LittleFS filesystem).
- Flash both artifacts: `pio run -t upload` (firmware) and `pio run -t uploadfs` (web UI).
- Reachable on the network at `http://flightwall.local` (mDNS) once connected.

### Tests
Three, and they run in different places.

**Host tests — no board needed.** The pure-logic suites (`test/test_*.cpp`: parsers,
classify, lru, buttons, clock, route, serverjson, serverbackoff) are standalone g++
programs, each with its own `main()`:
- `./run_host_tests.sh` — build and run all of them; exits non-zero if any fails.
- `./run_host_tests.sh route lru` — just those.

Adding `test/test_foo.cpp` is enough for it to be picked up; the runner globs, so there
is no list to update. Each file guards its body with `#ifndef PIO_UNIT_TESTING`, which
is what keeps it out of the `pio test` binary — see the comment in `platformio.ini`.

**On-device tests.** Unity suite in `test/test_logic/`, covering filters and the
Settings JSON parse/round-trip:
- `pio test` — build, flash, and run on a connected ESP32 (reports over serial).
- `pio test --without-uploading --without-testing` — compile-only check, no board needed.

**Web UI — no board needed.** `data/index.html` is served from LittleFS, so the only
way to exercise it used to be `pio run -t uploadfs`, which erases `/settings.json`.
Instead, stub the device API and drive the real page in a browser:

```bash
node ../tools/webui_stub.mjs        # http://localhost:8099
```

Query-string knobs make the awkward states reachable — a slow or failing
`/api/settings`, a hostile SSID, firmware without the heap-block fields — and
`/__probe` reports what the page actually sent. The script header lists the knobs and
carries a reproduction recipe for each of the four defects the 2026-08-23 audit found
here, written as the assertion that fails on unfixed code.

It refuses to start if its canned settings payload is missing any field
`loadSettings()` reads: an incomplete stub makes the page throw partway and leaves
Save disabled, which looks exactly like the bug you would be testing for.

### Notes
- OpenSky OAuth is required for `states/all`. Token auto-refreshes with a safety skew.
- Display uses a HUB75 RGB matrix via `ESP32-HUB75-MatrixPanel-DMA`; set the pin map in `config/HardwareConfiguration.h` and the panel width/height/chain from the web UI.