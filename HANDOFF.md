# FlightWall OSS — Handoff Notes

Status snapshot for the next agent. Branch `flightwall-mini-parity`, fork
`chaim354/TheFlightWall_OSS` (`origin`). Read §0 and §2 before touching anything.
Local `HEAD` == `origin/flightwall-mini-parity` as of this writing.

---

## 0. ⚠️ VERIFICATION STATUS — read this first

The device is an **ESP32-S3-DevKitC-1 N16R8**, running on the wall, showing flights.
Most of what earlier handoffs called "never run on hardware" now IS device-verified.

| Work | Status |
|---|---|
| S3 migration (PSRAM, pin map, 6-bit depth) | **DEVICE-VERIFIED.** PSRAM 8.35MB live, flights render, web UI loads. |
| Enrichment, logo LRU sizing, TCS3472 read path, buttons, web UI | **DEVICE-VERIFIED.** |
| 6-bit colour-depth fix (`4218dc0`) | **Device-verified but on ONE ping sample per condition** — see §3. The fault swings ~32× between identical back-to-back runs, so treat the 75%→0% result as strong-but-not-proven. |
| Clock / timezone / new defaults (`eea030d`) | **COMPILE + HOST-TEST ONLY.** The board dropped off USB before it could be flashed. The ONLY unverified commit from this session. |
| `WiFi.setSleep(false)` (`d010d8d`) | **A DISPROVEN NO-OP.** Modem sleep was already off (verified in core source). Harmless but the message frames it as a fix; revert or amend when convenient. |

Both envs (`esp32dev`, `esp32s3`) build clean. Host tests all pass:
`cd firmware && for t in parsers classify lru buttons clock route; do g++ -std=c++17 test/test_$t.cpp -o /tmp/t && /tmp/t; done`

`main` is stale; everything lives on `flightwall-mini-parity`.

---

## 1. THE BIG FINDING — 8-bit HUB75 DMA was starving the WiFi radio

Nearly every fault chased across this session was ONE root cause: at 8-bit colour
depth the panel's continuous I2S DMA saturated the memory bus and starved WiFi of
timely interrupt service. Dropping to 6-bit (`-D PIXEL_COLOR_DEPTH_BITS=6` on the
`esp32s3` env, which had silently omitted it) took **packet loss 75%→0% and min RTT
829ms→12ms**, measured against a router that answered in 3ms throughout.

This explains, in one stroke: the `-1` TCP connect timeouts, `-80` mid-handshake
resets (`MBEDTLS_ERR_NET_CONN_RESET`), `-29312` EOF, `DNS Failed`, both loopTask
watchdog panics, the truncated/`IncompleteRead` web page, and multi-second settings
POSTs. It was NEVER: memory (139–192KB contiguous throughout), RF strength (RSSI −58),
rate limiting (30-min token cache), or modem sleep (verified off).

**CAVEAT (be honest with the user about this):** the 6-bit result rests on a single
~10-second ping sample per condition, and this fault demonstrably swings 32× between
identical runs (an "external PSU" test read 84% loss then 0% minutes apart, same
hardware — the first was measured mid-reboot). The relationship is probably real but
was never established with a proper multi-minute-per-condition run. If flights still
drop routes, the next lever is **4-bit depth** (halves panel data again; costs
brightness banding — 16 levels/channel vs 64). One flash would test it.

Cost of 6-bit: 64 brightness levels/channel instead of 256, same trade `esp32dev`
already makes. Watch the panel for banding on gradients.

---

## 2. TRAPS — hard-won, verified. Do not re-learn these.

**Toolchain / Serial**
- `platform = espressif32` resolves to **arduino-esp32 2.0.17 / IDF 4.4.7**. pioarduino is
  the only route to 3.x; the S3 env builds fine on 2.x.
- **The S3 has TWO USB ports and Serial splits across them.** `ARDUINO_USB_CDC_ON_BOOT`
  defaults to 0 → `Serial` binds UART0 → every `Serial.print` goes out the UART port.
  But `CONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG=y` mirrors IDF `log_e()`/panics to the
  NATIVE port. So monitoring the native port shows `[E]` lines and panic dumps while
  SILENTLY dropping `[boot]`/`[heapdiag]`/fetch logs — reads exactly like "firmware stopped
  logging." Fixed: `-DARDUINO_USB_CDC_ON_BOOT=1` (in `platformio.ini`), Serial now on native.

**Heap / PSRAM**
- `heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)` is the number that matters, NOT
  `getFreeHeap()`. **`ESP.getFreeHeap()` is `MALLOC_CAP_INTERNAL` only — it does NOT include
  PSRAM** (the old comment at `main.cpp` `logHeap` claiming otherwise is WRONG; that's true of
  `MALLOC_CAP_8BIT`, not `getFreeHeap`). This error cost a wrong hypothesis this session.
- PSRAM spill threshold is **4096** (`CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL`), a preference.
- ~2KB logo tiles sit BELOW 4096 → they land in **internal** RAM even on the S3; 8MB PSRAM
  does not rescue them. Logo cache is capped per target (`kMaxLogoTiles`: 16 on S3, 8 on ESP32).
- `board_build.arduino.memory_type = qio_opi` is **load-bearing** on the N16R8. Wrong value →
  0 bytes PSRAM, silently. The `[boot] PSRAM: size=… found=…` line is the go/no-go.

**Watchdog / tasks — coredumps are your friend**
- Loop WDT is at **120s** (`enableLoopWDT`, only if `esp_task_wdt_init` returned OK). `PANIC=y`,
  so a loop() that blocks >120s REBOOTS.
- **The panic BACKTRACE is a red herring** — it shows core 0's watchdog ISR interrupting the
  WiFi task (`pm_rx_beacon_process`), NEVER loopTask. Ignore it.
- **The COREDUMP has every task's real stack.** Enabled to flash (`CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=y`),
  64KB partition at `0xFF0000`. To read it:
  ```
  # close the serial monitor first
  ~/.platformio/penv/bin/python ~/.platformio/packages/tool-esptoolpy/esptool.py \
    --chip esp32s3 --port <port> --baud 460800 read_flash 0xFF0000 0x10000 /tmp/cd.bin
  .venv/bin/esp-coredump --chip esp32s3 info_corefile --core /tmp/cd.bin --core-format raw \
    --gdb ~/.platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-gdb \
    --save-core /tmp/core.elf firmware/.pio/build/esp32s3/firmware.elf
  # then: xtensa-esp32s3-elf-gdb -batch -ex "thread apply all bt" firmware.elf /tmp/core.elf
  ```
  (`esp-coredump`'s own `--port` path wants a full ESP-IDF install; the raw `read_flash` +
  `--core` route sidesteps that. Header first bytes `e4 50 …` = a real dump; `ff ff ff ff` = none.)
- **Two coredumps this session both showed loopTask blocked on a NETWORK call** inside
  `doFetchAndRender`: one in `mbedtls_ssl_handshake` (`ssl_client.cpp:277`), one in a TCP
  connect to hexdb (`lwip_select`). That's why the enrichment budget (§below) exists.

**Networking**
- OpenSky spans TWO hosts (`auth.opensky-network.org` for the token, `opensky-network.org` for
  states). `HTTPClient::connect()` reuses a socket WITHOUT comparing hosts, so a shared
  `WiFiClientSecure` sends the states GET down the auth connection. `OpenSkyFetcher::secureClient()`
  calls `stop()` before each handoff. (Fixed in `5591fdc` after being reintroduced by `a43606e`.)
- OpenSky's own client needs `setHandshakeTimeout(15)` — otherwise it inherits the 120000ms
  default == the watchdog, and a stalled handshake is a guaranteed reboot.
- `useHTTP10(true)` disables keep-alive; OpenSky needs it (chunked body), HttpJson must NOT use it.
- `404` from adsbdb/hexdb is "not in this DB," not a failure.
- The CA bundle is compiled in but **unreachable from Arduino on 2.0.17**. `setInsecure()` is
  used everywhere (still an open security item — §4).
- **NTP gates TLS.** `configTzTime` gates on sync; unsynced → cert "not yet valid."
- **`uploadfs` ERASES LittleFS** including `/settings.json`. Back settings up first (see §6).

**Hardware**
- Brownout is already at the most permissive level. **USB power has been more reliable than the
  bench PSU this session** — but also the USB connection has DROPPED MID-FLASH three times under
  sustained write load. Suspect a marginal cable; a torn app-partition write is recoverable
  (ROM bootloader is intact) by reflashing completely.

---

## 3. Open items

**Route data is a schedule lookup, not live tracking (NEW — this is a real user-facing bug).**
adsbdb and hexdb both map a callsign STRING to a statically-scheduled route; neither knows where
the aircraft is. For `AAL1533` this session: adsbdb said LAS→CLT, hexdb said PHL→MIA (2018 data),
and the aircraft was actually flying **CLT→BOS** over New York. All three disagreed. hexdb is only
consulted for what adsbdb MISSED, so it can't correct a confident-but-wrong answer.
- **OpenSky `/flights/aircraft?icao24=…` gives the correct ORIGIN from observed ADS-B** (free,
  same creds already in use) — but `estArrivalAirport` is `None` mid-flight (only known after
  landing). So the honest display is `CLT→?`, not a fake full route.
- Best free idea discussed: use OpenSky's live origin as a **sanity check** on adsbdb's route —
  if origins disagree, adsbdb is stale, suppress it. Not yet built.
- AeroAPI is the only source that knows destination mid-flight, and it's billable.

**Enrichment now has a per-cycle time budget (`36aca5b`).** `kEnrichBudgetMs = 45000`. Past it,
`getEnriched(..., allowNetwork=false)` serves cache-only and opens no connections, so a bad link
degrades (fewer routes) instead of rebooting. This is the fix for the watchdog panics; it does NOT
fix the link. If panics recur on a bad link, lower the budget.

**Light sensor (TCS3472) reads wrong — placement, not code.** Reads ~24 in a lit room (was 1720
lit / 13–90 dark earlier when correctly placed). No threshold works across an 11-count gap. The
sensor is face-down / shadowed / seeing the panel. `id=0x00` means nothing on the I2C bus at all —
reseat 41/42/3V3/GND. Chip-ID check correctly fail-safes to "lit" so the panel stays on. Also tie
the breakout's `LED` pad to GND (onboard illumination LED poisons the reading).

**`showGeneralAviation:false`** hides GA/private tails (N-numbers). The plane visibly overhead near
JFK is often a GA aircraft the two-pass filter drops. Flip it on if the user wants those.

**Security (audited, none done):** `GET /api/settings` returns WiFi PSK + OpenSky secret + AeroAPI
key in plaintext, unauthenticated (confirmed by pulling them this session). Fix: a redacted
`toJson` variant emitting `wifiPasswordSet:true` booleans. Also: open setup AP + terminal (never
retries STA), and `setInsecure()` on billable-key paths. User has deferred all three.

**Stale comments to clean up:** `getFreeHeap`/PSRAM comment (§2). `BaseDisplay::framebuffer()` /
`Hub75Display::framebuffer()` are now DEAD CODE (the web preview was removed in `17b213c`) whose
comments still describe a preview — safe 3-line deletion, `Hub75Display` is the only implementor.

**`[heapdiag]` instrumentation** still in `main.cpp`/`Hub75Display::initialize`. Strip when done.

---

## 4. This session's commits (newest first)

```
eea030d  feat(clock): real time zones with DST, 12-hour display   [COMPILE-ONLY, unflashed]
36aca5b  fix(fetch): bound network enrichment per cycle           [proven by coredump]
4218dc0  fix(s3): 6-bit colour depth — DMA starving the radio     [1 sample/condition — see §1]
1f3b1dd  feat(web): restructure into five cards, gzip the page
1facb73  feat(buttons): two physical buttons for brightness/mode
5591fdc  fix(opensky): don't reuse one TLS client across two hosts
a6d82e6  feat(console): add `light` / `light watch`
91d2892  feat(light): add TCS3472, board-guard light-sensor pins
d010d8d  fix(wifi): disable modem sleep on the S3                  [DISPROVEN NO-OP]
f5b5520  fix(display): size the logo tile cache to the working set
17b213c  refactor(web): drop the live preview, surface distance
b001049  fix(build): route Serial to the native USB port on the S3
```

New settings this session: `buttons.enabled` (default on), `light.type=tcs3472` (default on),
`schedule.timezone` (POSIX TZ string — **replaced** `timezoneOffsetMinutes`, breaking change),
board-guarded button pins (S3 18/21, ESP32 18/33), 12-hour clock, defaults brightness=20 /
maxFlights=8 / flightNumberOverVr=on / noFlightsMode=clockfact.

Pins now reported in `/api/status`: `i2cSda/i2cScl/adc1Min/adc1Max/buttonAPin/buttonBPin`
(one index.html serves both boards, so it asks the device rather than hardcoding a map).

---

## 5. Logos (IMPORTANT policy — unchanged)

- **Real airline logo tiles are LOCAL-ONLY — never commit them.** 131 `ICAO.rgb565` files in
  `firmware/data/logos/` are modified locally (the user's trademarked FlightAware/radarbox set)
  and MUST stay uncommitted. Only ever `git add` logo files **by explicit path**; NEVER
  `git add firmware/data/logos/` or `git add -A`. (100 generated badges ARE tracked and fine.)
- Tools in `tools/`: `gen_*_logos.py`, `png_to_rgb565.py`, `convert_logo_folder.py`. Pillow in `.venv`.

---

## 6. Build / flash

```bash
cd firmware
pio run -e esp32s3                 # or -e esp32dev
pio run -e esp32s3 -t upload       # close the serial monitor first (port lock)
pio run -e esp32s3 -t uploadfs     # web UI — regenerates index.html.gz, ERASES settings
pio device monitor -e esp32s3      # native USB port
```
`extra_scripts = pre:../tools/gzip_web_assets.py` regenerates `data/index.html.gz` every build
(gitignored); `handleRoot()` serves it with `Content-Encoding: gzip` and falls back to the plain
file. **Do NOT `sendHeader("Content-Encoding")` manually** — `streamFile()` adds it for `.gz`
filenames, and doubling it means the body is decoded as gzipped-twice (renders nothing).

**Back up settings before `uploadfs`** (it wipes `/settings.json`; creds reseed from `Secrets.h`,
nothing else does):
```bash
curl -s http://<device-ip>/api/settings -o ~/flightwall-settings-backup.json
# after uploadfs, POST it back, then re-pick the timezone from the dropdown (now UTC0)
```

Host tests: `g++ -std=c++17 test/test_{parsers,classify,lru,buttons,clock,route}.cpp -o /tmp/t && /tmp/t`.
