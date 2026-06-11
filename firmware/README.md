# TheFlightWall Firmware

This is a high-level overview of the firmware that powers TheFlightWall on ESP32.

### What it does
- **Configures itself over the web** — a built-in `WebServer` + single-page UI (served from LittleFS) replaces the mobile app. WiFi, API keys, location, filters, layout, and schedule are all runtime settings persisted on the device.
- **Two tracking modes**:
  - *Area* — OpenSky `states/all` filtered by location/radius; live metrics come from the ADS-B state vector.
  - *Flights* — a user list of idents/callsigns/tails looked up directly via AeroAPI; metrics from `last_position`.
- **Enrich flights** (airline / route / aircraft type) from a selectable source: **adsbdb.com** (free, no key — default), **AeroAPI** (paid; usable as primary or as a backup that only fires when adsbdb misses), or off. Results are cached per aircraft to minimize requests. Friendly names also come from TheFlightWall CDN.
- **Render** a Mini-style flight card — airline logo tile on the left, then a configurable set of fields (flight #, route, aircraft, altitude, speed, heading, vertical rate) on the right — on a **HUB75 RGB LED matrix**, cycling up to N flights. Logos load from `data/logos/<ICAO>.rgb565`; airlines without a tile get a brand-style code badge.
- **Live web preview** — each frame is composed into an in-RAM `GFXcanvas16` and blitted to the panel; the same buffer is served at `/api/framebuffer` so the web UI mirrors the wall pixel-for-pixel.
- **Brightness scheduling** — day/night brightness using NTP time.
- **WiFi provisioning** — falls back to a `FlightWall-Setup` access point with a captive portal when no credentials are saved.

### Key components
- **src/main.cpp**: Entry point. Loads settings, connects WiFi (or starts setup AP), starts the web server + NTP, then periodically fetches/enriches/renders and applies scheduled brightness.
- **core/Settings**: Runtime, web-editable settings persisted to `/settings.json` on LittleFS; seeded from the compile-time `config/*.h` defaults on first boot.
- **core/WebConfigServer**: HTTP server + REST API (`/api/settings`, `/api/status`, `/api/flights`, `/api/wifiscan`, `/api/restart`) and captive-portal DNS for setup mode.
- **core/FlightDataFetcher**: Orchestrates both tracking modes; applies filters + the maxFlights cap; merges metrics; enriches names.
- **adapters/OpenSkyFetcher**: Queries OpenSky states/all with OAuth; parses and filters by geo. Reads credentials from runtime settings.
- **adapters/AeroAPIFetcher**: Retrieves flight details + last-position metrics by ident via AeroAPI.
- **adapters/FlightWallFetcher**: Looks up human-friendly airline/aircraft names from CDN.
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
Pure logic (filters + Settings JSON parse/round-trip) is covered by Unity tests in `test/`:
- `pio test` — build, flash, and run on a connected ESP32 (reports over serial).
- `pio test --without-uploading --without-testing` — compile-only check, no board needed.

### Notes
- OpenSky OAuth is required for `states/all`. Token auto-refreshes with a safety skew.
- Display uses a HUB75 RGB matrix via `ESP32-HUB75-MatrixPanel-DMA`; set the pin map in `config/HardwareConfiguration.h` and the panel width/height/chain from the web UI.