# FlightWall OSS — Handoff Notes

Status snapshot for the next agent. Branch `flightwall-mini-parity`, fork
`chaim354/TheFlightWall_OSS`. Read §0 and §2 before touching anything.

---

## 0. ⚠️ VERIFICATION STATUS — read this first

| Work | Verified how |
|---|---|
| Enrichment refactor (the `? → ?` blank-route fix) | **DEVICE-VERIFIED.** Routes/airlines/aircraft populate near JFK, no TLS failures, no OOM. |
| Everything after that — efficiency pass, overnight features, WiFi fixes, Tier-1 bug fixes, logo LRU | **COMPILE + HOST-TEST ONLY. Never run on hardware.** |

Both envs (`esp32dev`, `esp32s3`) build clean; `test_parsers` / `test_lru` /
`test_classify` all pass (`cd firmware && g++ -std=c++17 test/test_X.cpp -o /tmp/t && /tmp/t`).
**Do not describe any of the unverified work as "working."**

`main` is stale at `344ffa0`; everything lives on `flightwall-mini-parity`.

---

## 1. What the firmware is now

- **ESP32 + HUB75** (`ESP32-HUB75-MatrixPanel-DMA`). Pins in `config/HardwareConfiguration.h`,
  **board-guarded** (`#if defined(CONFIG_IDF_TARGET_ESP32S3)`) — the ESP32 map is invalid on S3.
  Frames compose into a `GFXcanvas16`, blitted; same buffer feeds the web preview.
- **`core/HttpJson`** — ONE shared persistent `WiFiClientSecure`, HTTP/1.1 keep-alive,
  streams bodies straight into ArduinoJson. Used by Adsbdb + AeroAPI. **OpenSky keeps its
  own HTTPClient** (needs a Bearer token + `useHTTP10` for its chunked body).
- **Enrichment** = local callsign-prefix (airline identity + logo, free) + **one live route
  call**: adsbdb → hexdb fallback. The FlightWall CDN layer was **deleted**. AeroAPI is an
  optional keyed backup.
- **Cache**: bounded LRU (`utils/LruCache.h`, 64 entries) with positive (10 min) / negative
  (60 s) TTLs via `utils/CallsignUtils.h::cacheActionFor`.
- **Two-pass selection**: airliners fill slots first; GA/private only if `showGeneralAviation`
  (default OFF). Cargo flagged + optional `hideCargo`. Classifiers in `utils/FlightClassify.h`.
- **Display**: Mini 128×64 / stacked / side-by-side. Splash screen, no-flights modes
  (`dots` default / `clock` / `funfact` / `clockfact`, facts in `config/FunFacts.h`).
  Render is **gated** — recomposes only on flight-index/data change, not every 200 ms.
- **Logo tiles**: 4-entry LRU of decoded tiles incl. **negative** entries.
- Settings in LittleFS `/settings.json`, **atomic** (tmp+rename). Web UI, serial console,
  light sensor, brightness schedule, auto-location, helicopter detection.

---

## 2. TRAPS — hard-won, verified. Do not re-learn these.

**Toolchain**
- `platform = espressif32` resolves to **arduino-esp32 2.0.17 / IDF 4.4.7**. The official
  platform pins 2.0.17 even at v7.0.1 (v7 bumped ESP-IDF, not Arduino). **pioarduino is the
  only route to 3.x.** The S3 env **builds fine on 2.x** — 3.x is an upgrade path, not a
  requirement.
- If you ever move to 3.x: `setCACertBundle()` is 1-arg on 2.x, **2-arg from 3.0.4+**, and
  **3.0.0–3.0.3 is broken** (`sizeof` on a pointer). `WiFiClientSecure` → `NetworkClientSecure`.
  `esp_task_wdt_init(timeout,panic)` → `esp_task_wdt_init(config*)` + `esp_task_wdt_reconfigure()`.

**Heap / PSRAM**
- The `? → ?` bug was **heap FRAGMENTATION, not total free heap**. TLS needs two ~16 KB
  *contiguous* buffers; 119 KB free with a 21 KB largest block still fails (`mbedTLS -32512`).
  **Always measure `heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)`, not `getFreeHeap()`.**
- PSRAM spill threshold is **4096** (`CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL`), **not 16 KB**,
  and it's a *preference* — either pool falls back to the other.
- **Task stacks CANNOT live in PSRAM.** `SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY=y` only affects
  `xTaskCreateStatic`; `xTaskCreate` always uses internal. 8 MB PSRAM won't help stacks.
- `CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL=0` — **nothing** reserved for DMA. Allocate the
  HUB75 panel early in `setup()` (it already is).
- `board_build.arduino.memory_type = qio_opi` is **load-bearing**. The stock
  `esp32-s3-devkitc-1` profile defaults to `qio_qspi` (quad) → an N16R8 gets **0 bytes of
  PSRAM, silently, with no build error.** The `[boot] PSRAM: size=… found=…` line is the go/no-go.

**Watchdog / tasks**
- `CHECK_IDLE_TASK_CPU1` is **unset** and loopTask is **unsubscribed** → a hung `loop()` is
  **silent**, no reset, no diagnostic. We now `enableLoopWDT()` at **120 s**, and only if
  `esp_task_wdt_init` returned `ESP_OK` (else it'd subscribe at the 5 s default and reboot-loop).
- **`PANIC=y` + CPU0 idle IS checked.** So moving the fetch to a core-0 task **without a
  `vTaskDelay(1)` in poll loops turns a benign stall into a panic reboot.**
- A fetch task must be **priority 2–5, BELOW lwIP's 18** — higher starves the TCP/IP task its
  own socket depends on. Stack sizes on ESP32 are **bytes, not words**.
- Never do TLS in a `WiFi.onEvent()` handler: 4 KB stack, priority 19, 32-deep queue posted
  with `portMAX_DELAY` → block it and the poster **deadlocks forever**.

**Networking**
- ~~`getStream()` breaks on OpenSky (chunked) — use `getString()`~~ — **THE OLD HANDOFF WAS
  WRONG.** `http.useHTTP10(true)` makes the server return an unchunked Content-Length body,
  and streaming works. OpenSky is streamed element-by-element today; there is no `getString()`
  on that path.
- **`useHTTP10(true)` disables keep-alive.** `HttpJson` deliberately does NOT use it (adsbdb/
  hexdb return Content-Length on 1.1). Only OpenSky needs it.
- **Batch calls by HOST, not by field.** One persistent client can hold one host; alternating
  adsbdb/hexdb (A,B,A,B) forces a renegotiation per call. `fetchFlightInfo` is A,A,B,B.
- `404` from adsbdb/hexdb is **not** a failure — it means "not in this DB". Silenced.
- The CA bundle IS compiled in (`CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y`, 136 certs, 63.7 KB
  flash, **~544 bytes RAM** — only the index is resident) but on 2.0.17 it is **unreachable
  from Arduino**: the shadowing `esp_crt_bundle.c` has an unimplemented fallback that returns
  `ESP_OK` on failure. To use it you must **embed your own** (`gen_crt_bundle.py` +
  `board_build.embed_files` + the path-derived `asm()` symbol).
- **NTP gates TLS.** ESP32 boots at 1970 → every cert reads "not yet valid" → first fetch
  fails `-0x2700`. `setInsecure()` currently masks this. Gate on
  `sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED` (NOT `getLocalTime()`, which only
  checks a year heuristic). Arduino resyncs every **3 h**, not the 1 h everyone quotes.
- **`uploadfs` ERASES LittleFS** including `/settings.json`. `config/Secrets.h` (gitignored)
  reseeds WiFi/OpenSky. Proper fix (still open): move settings to NVS/Preferences.

**Hardware**
- Brownout is already at the **most permissive** level (7 = 2.44 V). If it browns out there's
  no config knob left — it's hardware. HUB75 current spikes + WiFi TX bursts coincide; use
  bulk caps + a PSU with headroom. **Never** `WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0)`.
- Coredump is **enabled and unused** — both partition tables reserve it. `idf.py coredump-info`
  will give a real backtrace off a device that hung on the wall.

---

## 3. Open items

**Security (audited; see `docs/` and §4) — none done yet:**
- **A. `GET /api/settings` returns the WiFi PSK + OpenSky secret + AeroAPI key in plaintext,
  unauthenticated.** Root cause: `toJson()` serves double duty (disk format AND HTTP body).
  Fix: a redacted variant emitting `wifiPasswordSet: true` booleans. `fromJson()` already
  guards on `containsKey`, so the write path needs no change. **Highest value, low risk.**
- **B. The setup AP is OPEN and terminal.** `startSetupAp()` has no password, and the
  reconnect watchdog is gated `if (!g_apMode)` → once in AP mode it **never retries STA**.
  Chain: deauth → reboot → open AP → `curl /api/settings` → home PSK from the sidewalk.
  Fix: WPA2 (password shown on the panel) + retry STA every ~5 min. Needs a UX call.
- **C. `setInsecure()` on every TLS call** — including the paths carrying the **billable**
  AeroAPI key and OpenSky `client_secret`. See §2 for the bundle + NTP traps. Riskiest; needs
  the board. Cheaper option: validate only the token-carrying paths.
- No auth at all on the config API; no `Host` check (DNS rebinding) or `Origin`/custom-header
  check (CSRF). **They are not substitutes — Host stops rebinding, Origin stops CSRF.**

**Other:**
- **NVS settings** so `uploadfs` stops wiping config (atomic save is done; NVS is not).
- **Fetch task** off `loop()` — see the §2 traps. The audit rates it an improvement, not a
  correctness fix (the DMA display doesn't stutter; the web UI does).
- **OTA — recommended AGAINST for now.** `huge_app.csv` has `otadata` but **no `app1`**, so
  it literally can't. More importantly: an OTA endpoint on an unauthenticated LAN server is
  RCE from any page the owner visits. Also `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` is
  **neutered** — Arduino's weak `verifyOta()` returns true and marks the image valid *before
  `setup()` runs*, so a boots-then-crashes image never rolls back. Override `verifyOta()`.
- `[heapdiag]` instrumentation is still in (`main.cpp` `logHeap`, `Hub75Display::initialize`).
  Strip after the S3 is verified.
- Logo tiles uncompressed (~536 KB; most are ≤256 colors — palette+RLE would save ~35%);
  `index.html` not gzipped (24.5 KB → 7.4 KB).

---

## 4. S3 migration — staged, not executed

`[env:esp32s3]` in `platformio.ini` + `firmware/partitions_16MB.csv` (2×3 MB app + ~9.9 MB FS;
**FS subtype/label must be `spiffs`** — `gen_esp32part.py` has no `littlefs` subtype).
Board-guarded S3 pin map is in `HardwareConfiguration.h`. Full checklist, wiring, and the
"what to watch" list: **`docs/s3-migration.md`**. Passive breakout netlist + copper-tape
routing guide: **`docs/hardware/`**.

Restoring `PIXEL_COLOR_DEPTH_BITS` 6→8 on the S3 is **not free** — PSRAM trades a memory limit
for a **DMA bandwidth** limit (~13 MHz cap). Validate refresh on real hardware.

---

## 5. Logos (IMPORTANT policy)

- **Real airline logo tiles are LOCAL-ONLY — never commit them.** ~78 `ICAO.rgb565` files in
  `firmware/data/logos/` are modified locally (the user's trademarked FlightAware/radarbox set)
  and **must stay uncommitted**. Only ever `git add` logo files **by explicit path**; never
  `git add firmware/data/logos/` or `git add -A`.
- **Committed and fine**: brand-colored code badges, the generic `_CARGO`/`_PRIVATE`/`_HELI`,
  and **19 cargo-carrier badges** (`tools/gen_cargo_logos.py`, 32×32).
- Tools in `tools/`: `gen_starter_logos.py`, `gen_special_logos.py`, `gen_cargo_logos.py`,
  `png_to_rgb565.py`, `convert_logo_folder.py`. Pillow lives in the repo `.venv`.

---

## 6. Build / flash

```bash
cd firmware
pio run -e esp32dev            # or -e esp32s3
pio run -e esp32dev -t upload  # close the serial monitor first
pio run -e esp32dev -t uploadfs   # web UI + logo tiles (WIPES settings)
pio device monitor -b 115200
```
`uploadfs` is needed whenever `data/` changes (index.html or tiles) — the GA/cargo toggles and
the 19 cargo badges are **not on the device until you do**.

Host tests: `g++ -std=c++17 test/test_{parsers,classify,lru}.cpp -o /tmp/t && /tmp/t`.

---

## 7. Open questions for the user (asked, unanswered)

- **Cargo default**: currently **shown** with a 📦 tag (per the HANDOFF plan's "non-destructive
  indicator"). The user said "turn off private and cargo planes" — flipping `hideCargo` to
  default-true is a one-line change if that's what they meant.
- **No-flights default**: left at `dots` (unchanged). `clock`/`clockfact` are built but unseen.
- **GA default OFF** (airliners-only) — confirm that's the intent.
- Fun-fact tone (24 factual aviation facts seeded).

---

## 8. Repo state

- `origin` = the user's fork; `upstream` = `AxisNimble/TheFlightWall_OSS`. Open PR #1.
- Kept local by explicit request: WiFi/OpenSky creds (`config/Secrets.h`), real logo tiles.
- Untracked screenshots in the repo root are the user's — leave them.
- Audit findings that produced §2/§3: seven research passes over the codebase, ESP32-S3
  best practices, and peer projects (WLED/ESPHome/Tasmota). Verdict: **architecturally
  mainstream** — single-core `loop()`, no web auth, and filesystem-JSON creds are all shared
  with the 18k★/24k★ incumbents. **`setInsecure()` + echoing secrets are the genuine gaps.**
