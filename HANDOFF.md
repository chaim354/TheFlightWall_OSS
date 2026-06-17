# FlightWall OSS — Handoff Notes

Status snapshot for the next agent. This branch (`flightwall-mini-parity`, fork
`chaim354/TheFlightWall_OSS`) takes the OSS firmware to FlightWall-Mini parity and
beyond. Read this before changing the flight-data or display paths.

---

## 1. What the firmware is now

- **ESP32 + HUB75 RGB matrix** (was WS2812). Driver: `ESP32-HUB75-MatrixPanel-DMA`.
  Pin map in `firmware/config/HardwareConfiguration.h`. Frames are composed into a
  `GFXcanvas16` then blitted; the same buffer feeds the web preview.
- **Web configuration & control** (no app): `core/WebConfigServer` + `data/index.html`.
  REST: `/api/settings`, `/api/status`, `/api/flights`, `/api/framebuffer`,
  `/api/wifiscan`, `/api/geolocate`, `/api/restart`. WiFi captive-portal setup AP
  (`FlightWall-Setup`) + mDNS (`flightwall.local`).
- **Runtime settings** persisted to LittleFS `/settings.json` (`core/Settings`),
  seeded from `config/*.h` on first boot.
- **Tracking**: Area (OpenSky) and Flights (idents/callsigns/tails).
- **Enrichment**: free **adsbdb.com** (default) + **hexdb.io** fallback; AeroAPI
  optional backup. Per-aircraft cache (10 min). See §4.
- **Display layouts** by panel shape: 128×64 "Mini" (logo + airline/route/aircraft +
  two metric rows), 64×64 stacked, 64×32/128×32 side-by-side. `adapters/Hub75Display`.
- **Logos**: 32×32 `.rgb565` tiles in `firmware/data/logos/`. See §6.
- **Serial console** (`core/SerialConsole`): `wifi`, `set <json>`, `get`, `restart`, etc.
- **Light sensor**, **brightness schedule**, **auto-location**, **helicopter detection**.

---

## 2. ⚠️ CURRENT OPEN ISSUE — OOM crash near JFK (in progress)

Near JFK (busy airspace) the device was rebooting. Backtrace = `operator new`
throwing in `OpenSkyFetcher::fetchStateVectors` while building the state vector
list = **heap exhaustion during the OpenSky parse** (`getString()` String + a full
`JsonDocument` of every aircraft ≈ 3× the response, plus the vector).

**Fix implemented (built, NOT yet confirmed on-device as of handoff):**
- `OpenSkyFetcher::parseStatesInto()` — **incremental parse, one aircraft at a time**
  into a tiny reused `JsonDocument` (never a full-response document). Bounded memory.
- Vector capped at 40; unused fields (country/squawk/sensors) no longer parsed.
- `try/catch` around the parse → on a heap spike it logs `parse aborted (low memory)`
  and skips the cycle instead of rebooting.
- Default radius lowered to **10 km** (`UserConfiguration.h`). 15 km over JFK is too
  much for this parse approach; 10 is the safe sweet spot.

**Last user report was a crash with a backtrace IDENTICAL to the pre-fix binary →
they were still running the OLD firmware.** Next step: confirm `pio run -t upload`
lands (`Hash of data verified.` / `[SUCCESS]`, serial monitor closed during upload),
then verify no reboots through a JFK rush. If it still aborts after a *confirmed*
upload, the addresses will differ → genuine new issue.

Possible further work if 10 km still isn't enough or they want a wider radius:
true streaming would help but `http.getStream()` does NOT decode OpenSky's **chunked**
response (tried — gave 0 flights), so we stay on `getString()` + incremental parse.

---

## 3. Key findings from debugging (don't re-learn these)

- **`404` from adsbdb/hexdb is NOT a failure** — it means that callsign/airframe
  isn't in their DB. Logged-but-silenced now (only real errors like `-1`/`429` log).
- **Heap was healthy (121k)** when enrichment was failing → the failure was NOT
  memory; it was **rapid-TLS churn from a redundant CDN call** (now removed, §4).
- **`getStream()` breaks** on OpenSky (chunked). Use `getString()`.
- **`uploadfs` ERASES LittleFS** including `/settings.json` → WiFi/OpenSky lost.
  Mitigation in place: `config/Secrets.h` (gitignored) reseeds them on boot. The
  *proper* fix (not yet done) is to move settings to **NVS/Preferences** so
  filesystem flashes never wipe config.
- **clock phase default = OFF** fixed an off-by-one pixel shift on the user's panel.
- Level shifter: the user's I2C/BSS138 board is **wrong** for HUB75 (too slow). A
  fast push-pull **74HCT245** is the right part; the panel also runs at 3.3V directly.

---

## 4. Flight-info flow + call audit (keep it lean)

Per fetch cycle (Area mode), `FlightDataFetcher::fetchAreaMode`:
1. **OpenSky `/states/all?...&extended=1`** — 1 call. Gives positions, metrics, and
   the ADS-B emitter **category** (index 17; **8 = rotorcraft**).
2. For each of the nearest ≤ `maxFlights`, **if not cached** (`getEnriched`, 10-min
   cache keyed by ICAO24):
   - adsbdb `/callsign/{cs}` → route + airline name + operator  (→ hexdb route if miss)
   - adsbdb `/aircraft/{icao24}` → ICAO type  (→ hexdb aircraft if miss)
   - **callsign prefix → airline ICAO** (PRIMARY airline source; `QFA3`→`QFA`). Local.
   - `enrichNames`: CDN airline name **only if still missing** (adsbdb usually
     supplies it — removing this redundant call fixed the enrichment failures);
     CDN aircraft friendly name (`A21N`→`A321neo`).
3. AeroAPI backup fires only if there's no data AND a key is set (never for
   airline-format callsigns, so no surprise paid calls).

Best case per new aircraft = 3 TLS; cached = 0. **When touching this, do not add
calls** — the device is sensitive to rapid TLS handshakes.

Open optimization: a **type→name cache** would dedupe the CDN aircraft call across
aircraft of the same type.

---

## 5. Pending plans / requested features (not yet built)

- **Refined private/cargo** (the prior attempt was reverted because it mislabeled
  un-enriched airliners like DAL/AAL as "private" and displaced them):
  - Private = **callsign is a tail number** (e.g. `N172SP`), NOT "enrichment failed".
  - **Two-pass fill**: airliners always take the slots first; GA only fills leftovers.
  - GA is **opt-in** ("show general aviation", default off), last priority.
  - Cargo = **non-destructive** indicator on already-identified freight operators
    (FedEx/UPS/Atlas…) + a hide filter. Generic icons exist: `_CARGO`, `_PRIVATE`.
- **Show un-identified helicopters/GA** (uses `_HELI` icon) — same two-pass approach.
- **NVS settings** so `uploadfs` stops wiping config.
- **ArduinoJson v7 cleanup**: `DynamicJsonDocument`→`JsonDocument` is DONE; the
  `containsKey` / `createNestedObject/Array` deprecations were intentionally left.

---

## 6. Logos (IMPORTANT policy)

- **Real airline logo tiles are LOCAL-ONLY — never commit them.** They're the user's
  personal FlightAware/radarbox set (trademarked). ~134 `ICAO.rgb565` files in
  `firmware/data/logos/` are modified locally and must stay uncommitted. The repo
  keeps the brand-colored code-badge versions instead.
- **Generic icons ARE committed**: `_CARGO`, `_PRIVATE`, `_HELI` (drawn shapes, no
  trademark) via `tools/gen_special_logos.py`.
- Tools: `gen_starter_logos.py` (badges), `png_to_rgb565.py` (one PNG),
  `convert_logo_folder.py` (batch, with brightness normalization + dark-on-transparent
  → white-bg handling). Logos are normalized by **brightest color channel** (≈235) so
  blue logos (Delta/JetBlue) drive their LEDs as bright as the rest. 32×32 for 128×64.

---

## 7. Build / flash / dev workflow

```bash
cd firmware
pio run -t upload      # firmware
pio run -t uploadfs    # web UI + logo tiles (WIPES saved settings — Secrets.h reseeds)
pio device monitor -b 115200   # close this before uploading!
```
- `config/Secrets.h` (gitignored, copy from `Secrets.h.example`) bakes WiFi + OpenSky
  creds so reflashes auto-reconnect. **Reminder: blank it before flashing a unit to
  give away.**
- PlatformIO uses homebrew python at `/opt/homebrew/Cellar/platformio/.../libexec/bin/python`
  (had to `pip install intelhex` there once).
- Pillow is in repo `.venv` (for the logo conversion scripts).
- Partition: `huge_app.csv` (logos overflowed `min_spiffs`).

---

## 8. Repo / commit state

- Default remote `origin` = the user's fork. `upstream` = `AxisNimble/TheFlightWall_OSS`.
- Open PR #1 on the fork.
- Work the user explicitly wants kept local: WiFi/OpenSky creds, real logo tiles.
- This commit includes all firmware/UI work since the last "known-good" plus this
  handoff doc; it is **WIP pending on-device verification of the OOM fix** (§2).
