# FlightWall OSS — Handoff Notes

Status snapshot for the next agent. Fork `chaim354/TheFlightWall_OSS` (`origin`).
Read §0 and §2 before touching anything, and §5 FIRST if you are about to push.
As of 2026-08-24 the current line of work is `main` at `eec3cb2`; earlier work is
on `flightwall-mini-parity`.

---

## 0. ⚠️ VERIFICATION STATUS — read this first

The device is an **ESP32-S3-DevKitC-1 N16R8**, running on the wall, showing flights.
Most of what earlier handoffs called "never run on hardware" now IS device-verified.

| Work | Status |
|---|---|
| S3 migration (PSRAM, pin map, 6-bit depth) | **DEVICE-VERIFIED.** PSRAM 8.35MB live, flights render, web UI loads. |
| Enrichment, logo LRU sizing, TCS3472 read path, buttons, web UI | **DEVICE-VERIFIED.** |
| Route-correctness fixes: hexdb first-leg parsing, leg-keyed enrichment cache, FR24 partial-inline overlay (`8b5075a`..`ccf1d40`) | **COMPILE + HOST-TEST ONLY.** Materially changes the enrichment path the row above verified; none of it has run on the device. Least exercised: the FR24 inline-overlay path (Task 3) — GA/private and route-less FR24 flights now depend on a per-flight enrichment lookup that previously never ran for them at all. |
| Server position source + adsb.lol fallback (`792224c`..`f5c2b5c`) | **DEVICE-VERIFIED end to end, 2026-08-23.** Earlier verification covered adsb.lol direct fetches and the server-failure fallback; the server HAPPY PATH is now confirmed too, against a live deployment at `flightwall.tinkerex.com`: 12 flights/cycle, 11 of 12 with a route, **10 of 12 with an ETA, and the maintainer confirmed flights with ETAs rendering ON THE PANEL** — the one thing every prior handoff had to leave unverified. Cross-board legs (`CHS>BOS ~35m`, `LGA>IND ~1h20`) resolve, which the duplicate-row bug fixed this session used to blank deterministically. The new web UI is flashed and serving. |
| 6-bit colour-depth fix (`4218dc0`) | **Device-verified but on ONE ping sample per condition** — see §3. The fault swings ~32× between identical back-to-back runs, so treat the 75%→0% result as strong-but-not-proven. |
| Clock / timezone / new defaults (`eea030d`) | **COMPILE + HOST-TEST ONLY.** The board dropped off USB before it could be flashed. The ONLY unverified commit from this session. |
| Audit remediation, Tiers 1-6 (branch `claude/audit-priority-list-d3dbf5`, 30 commits) | **DEVICE-VERIFIED, 2026-08-23.** Flashed (firmware + `uploadfs`) and the server deployed. Confirmed on hardware: ETAs render on the panel; `/api/settings` no longer returns any secret in plaintext (`wifiPasswordSet` booleans only); `adc1Min/Max` now advertises `1-3`, not the `1-10` that included seven HUB75 data lines; `seedDefaults()` reads its config constants (`tile cache capacity=15 (maxFlights=12)`); the setup AP no longer absorbs (no reboot loop with no credentials stored). Held pending the `-DCORE_DEBUG_LEVEL=4` measurement run: F-FW09-A (TLS keep-alive branch choice) and F-FW12-A's 13-site FR24 migration. |
| Idle-when-dark + server quiet hours (`14e0647`..`01ae579`), merged as `eec3cb2` | **DEVICE-VERIFIED, 2026-08-24.** Flashed APP-ONLY (`-t upload`, deliberately NOT `uploadfs`) -- settings survived, device rejoined on its own. Gate confirmed on hardware: brightness 0 -> `/api/status` note `panel dark - fetch paused`, held across a full 60s interval with the 12 held flights RETAINED (70s < the 360s stale window), then `fetch ok` within one cycle of restoring brightness. Server deployed (`eec3cb2f09ea`, healthy) with `REFRESH_QUIET_HOURS=0-6` live; its boot log `schedule: 3144 rows from 4/4 boards` IS the cold-start refresh added this session. NOT exercised: the stale-discard path (needs >6min dark) and the quiet window itself (needs 00:00-06:00 ET). Note the device half is INERT as configured -- `schedule.enabled=false`, `nightBrightness=5`, `light.enabled=false` mean nothing reaches brightness 0. |
| No-JS `/setup` form (`b7ba300`) | **DEVICE-VERIFIED, 2026-08-24.** First-time provisioning had no `<form>` at all: `/` is ~11KB gzipped and posts via `fetch()`, but the browser that opens on joining an open network is a restricted captive-portal WebView -- so with scripting limited there was no way to submit credentials, which is the "could not set WiFi from the AP" failure. `/setup` is 1227 bytes as served, no `<script>`, no `<img>`, one plain form; the AP captive redirect now points there instead of `/`. Confirmed on hardware: renders the stored SSID, an empty-SSID POST re-renders with a banner WITHOUT restarting or altering settings, and a POST of the current SSID with a blank password saves, reboots and rejoins -- which is also what proves blank-password-means-unchanged preserves the credential. NOT exercised: the actual captive-portal sheet on a phone (would require clearing credentials, and the password is not recoverable from `/api/settings` by design). |
| Tracked flights, server side (`claude/tracked-flights` + `claude/tracked-wiring`) | **LIVE-VERIFIED end to end, 2026-08-24, against the real APIs.** `POST /v1/tracked {number,date}` -> the tick resolves it through AeroDataBox within one 120s cycle: observed `pending` -> `resolved` with `icao24=406947`, `reg=G-STBG`, `LHR->JFK`. 417 server tests. TWO measured findings the design had wrong: OpenSky **Basic auth does not authenticate** -- it returns 200 with real data from the anonymous 400/day tier (`x-rate-limit-remaining` 395 vs 3999 on Bearer), now OAuth2 client credentials with a cached token; and a single-`icao24` query costs **4 credits, not 1**, so the budget is ~1000 queries/day and the tick is 120s, not the planned 60s. NOT yet verified: the panel marker on real hardware (built, not flashed), and no tracked flight has yet been followed through an actual airborne window. |
| `WiFi.setSleep(false)` (`d010d8d`) | **A DISPROVEN NO-OP.** Modem sleep was already off (verified in core source). Harmless but the message frames it as a fix; revert or amend when convenient. |

Both envs (`esp32dev`, `esp32s3`) build clean. Host tests all pass:
`cd firmware && ./run_host_tests.sh`

`main` is CURRENT as of 2026-08-24, not stale: the audit remediation AND the
idle-when-dark work are merged into it as `eec3cb2` (48 commits from
`claude/audit-priority-list-d3dbf5`, which branched at `d58ed83`). That is exactly
what is flashed to the device and deployed to the server. `main` is 208 commits
ahead of `upstream/main` and NOT pushed; `origin/main` sits on a different commit.
Earlier work lives on `flightwall-mini-parity`.

The plan those 30 commits execute is `docs/superpowers/audits/2026-08-23-priority-list.md`,
derived from `docs/superpowers/audits/2026-08-23-simplification-audit.md` (which lives on
`claude/codebase-simplification-audit-2f73a3` and should be merged alongside, so the
findings and their remediation land together). Open decisions are tracked in
`docs/superpowers/audits/2026-08-23-decision-memo.md` — Q7 (the KV migration) is the
only one still unanswered, at its documented default: defer.

---

## 1. THE BIG FINDING — 8-bit HUB75 DMA was starving the WiFi radio

> **SUPERSEDED IN PART (2026-08-23 and 2026-08-24). Read this before acting on the
> section below.** The DIRECTION is right -- the panel's I2S DMA does degrade the
> radio -- but the stated MECHANISM and the stated next lever are both wrong. Measured
> since with 100- and 120-packet runs, not the single ~10s sample this section warns
> about:
>   - **Colour depth does NOT matter.** 4-bit was no better than 6-bit. This is what
>     refutes "saturated the memory bus": depth is exactly what changes bus load, and
>     changing it changed nothing.
>   - **I2S clock rate DOES.** 16 MHz measured 7.5 / 35.8 / 40% loss across runs.
>   - **RIBBON SEATING DOMINATES EVERYTHING ELSE.** Reseating took 11-35% -> 0-1.7%
>     the first time, and **21.0% -> 0.0% (528ms -> 7.2ms avg RTT)** on 2026-08-24,
>     with RSSI at -46 throughout -- so not a range problem, and the router answered
>     at 0% / 2.9ms in the same runs. It has now degraded TWICE, both times shortly
>     after the device was physically handled, which points at MECHANICAL RETENTION
>     rather than a one-off seating error.
>
> Practical rule: when fetches start failing, **ping the device for 100 packets and
> reseat the ribbon BEFORE touching firmware.** At ~21% per-packet loss a TLS
> handshake needs ~10 packets to survive and each retransmit costs seconds against
> `FlightWallServerFetcher`'s 4s budget, so it essentially cannot complete -- which
> presents as "the server is broken" when the server is fine. Keep 6-bit; it costs
> little. The 4-bit suggestion below has been tried and did not help.

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

**RAISED STAKES since 2026-08-24:** this is no longer only a brightness bug. The
idle-when-dark gate suppresses ALL fetching at effective brightness 0, and the
ambient sensor is a default-on path to 0 (`lightSensorEnabled=true` with
`lightSensorDimInstead=false` -> blank, not dim). So a mis-sited sensor reading ~24
against the 500-count threshold would now blank the panel AND stop it fetching in a
lit room. It is currently disabled on the wall device (`light.enabled=false`), so
this is latent -- but DO NOT enable the sensor until it is reseated and reading
sanely. `/api/status` keeps serving through suppression and reports
`lightLevel`/`lightDark` plus the note `panel dark - fetch paused`, so the cause is
visible rather than looking like a hang.

**`showGeneralAviation:false`** hides GA/private tails (N-numbers). The plane visibly overhead near
JFK is often a GA aircraft the two-pass filter drops. Flip it on if the user wants those.

**Security — two of three DONE (2026-08-23), one still open.**
- ~~`GET /api/settings` returns credentials in plaintext~~ **FIXED.** `toJsonPublic()` serves a
  redacted projection (`wifiPasswordSet` booleans); `toJson()` stays full for persistence, since it
  is also the on-flash format. `fromJson` now treats an EMPTY secret as "unchanged, never clear",
  so a cached old page cannot blank the PSK. Verified on the device: no plaintext secret fields.
- ~~Open setup AP never retries STA~~ **FIXED.** `g_apMode` was set and never cleared, gating the
  whole self-heal block — a power cut that beat the router up stranded the device broadcasting an
  open AP permanently. Now reboots to retry after 10 min *when credentials exist*; with none stored
  it stays up (genuine first-time provisioning). Retry window resets on a settings WRITE, not on
  station count — a phone auto-rejoining the remembered open AP would otherwise re-create it.
- **STILL OPEN:** `setInsecure()` on billable-key paths (`APIConfiguration.h:39`
  `AEROAPI_INSECURE_TLS = true`). Also NOT addressed, deliberately: a LAN peer can still restart
  the device and rewrite its settings, including pointing `serverUrl` at a host they control. The
  config UI has no auth, and a token the page itself hands out would be theatre. README says so.

**Stale comments to clean up:** `getFreeHeap`/PSRAM comment (§2).
~~`BaseDisplay::framebuffer()` / `Hub75Display::framebuffer()` dead code~~ **DELETED 2026-08-23**,
along with the `firmware/README.md` line that still advertised the removed `/api/framebuffer`
endpoint to downstream builders.

**`[heapdiag]` instrumentation** still in `main.cpp`/`Hub75Display::initialize`. Strip when done —
deliberately NOT stripped on 2026-08-23, because the pending `-DCORE_DEBUG_LEVEL=4` run is supposed
to produce a heap baseline and the web UI only just started rendering these numbers. Removing the
instrumentation immediately before the measurement it exists for is the wrong order.

**Serial console: NOT broken — the earlier entry here was wrong.** A previous
version of this file claimed the console was dark. It is not, and the claim was
retracted the same day after testing properly. What actually happened: reads used
pyserial's constructor form (`serial.Serial(port, 115200, timeout=1)`), which leaves
DTR at the hardware default, and the windows were shorter than the device's output
interval.

**How to read it reliably** — set DTR/RTS explicitly BEFORE `open()`:

```python
s = serial.Serial(); s.port='/dev/cu.usbmodem1101'; s.baudrate=115200
s.dtr = True; s.rts = False          # dtr=False RESETS the board
s.open()
```

Verified 2026-08-24: writing `help\n` returns the full 15-command list, and a
passive 80s listen captured `[heapdiag] cycle-start`, `[fetch] server: 12 flights`,
`Enriched flights: 12`.

Two traps that made this look dead:
- **The device is nearly silent by design.** In steady state it emits ~3 lines per
  fetch cycle (60s at the shipped interval). Any window under ~70s can legitimately
  return nothing. Send `help` to prove liveness instead of waiting.
- **`dtr=False` resets the board.** If your capture begins with `[boot] PSRAM:`, you
  rebooted the device rather than attaching to it, and you are reading a boot burst,
  not steady state. This also makes a DTR A/B look decisive when it is not.

### ⚠️ The biggest open item is in §5, not here

**131 trademarked logo tiles are committed and public.** Commit `22cb724`
(2026-07-20) added exactly the 131 files §5's policy says must never be
committed, and it is an ancestor of `origin/main` on the public fork -- so they
have been published since July. Undoing it means rewriting already-pushed
history across at least three remote branches, or making the fork private, or
deciding the exposure is acceptable. All three are the maintainer's call and
none should be done by an agent unprompted. Full detail and the corroborating
counts are in §5.

### Tracked flights — open items (2026-08-24)

**`/v1/tracked` IS PUBLICLY WRITABLE.** Deliberate, not an oversight -- the
maintainer chose to ship it unauthenticated for now, and this records that as a
decision. `flightwall.tinkerex.com` is public, so anyone who finds the URL can add
entries (spending metered AeroDataBox and OpenSky quota) and read which flights,
and so which people, are being followed. FOUR guards bound the damage and are
load-bearing rather than defensive polish -- do not relax any of them without
adding auth first:

- at most 20 stored entries
- dates restricted to today-1 .. today+14
- at most 50 AeroDataBox resolutions/day for this feature
- automatic expiry (2h after landing, 24h after an unresolved miss)

Adding a shared-secret header is a one-line middleware over `routes.ts`; the
guards stay useful either way and the seam was left clean on purpose.

**As of 2026-08-24 that surface includes a PAGE, at `GET /`** (`src/tracked/page.ts`,
served by `server.ts`). It is a browser UI for the same three routes -- add, list,
remove -- and it is unauthenticated for the same reason they are. It grants no
capability a `curl` did not already have, but it does mean the root of a public
server now advertises the feature to anyone who loads it, where previously they
had to know the endpoint existed. If auth is ever added, the page needs it in the
same change, not after: an authenticated API behind an open page is the worst of
both, since the page would simply fail in the browser with no way to sign in.

**Two paths are still verified only by unit tests.** Everything up to and
including a live OpenSky fix was confirmed in production against a real
transatlantic flight (DL182, JFK->FCO). NOT confirmed on hardware:

- **Dead-reckoning across an ADS-B coverage gap.** Community ADS-B has large
  oceanic holes, so a transatlantic flight should switch to an estimated
  position mid-crossing. The test flight was deleted while still over land.
  Track a transatlantic departure and leave it running to exercise this.
  **Check it on the server, not on the panel** -- the watched-flights page at
  `GET /` names the state per entry ("estimated position ... last fix N min
  ago"), and `/v1/flights` still carries `pos_src`. The panel no longer shows
  the difference; see the marker entry below.
- **The heading fallback.** Heading shows only on a card with NO ETA; every
  flight overhead during testing resolved a route, so it never triggered. GA and
  N-number traffic typically lack ETAs and should surface it.

**The OpenSky secret is the only plaintext credential in `.kamal/secrets`.** The
other four resolve through 1Password (`$(op ...)`); `OPENSKY_CLIENT_ID` and
`OPENSKY_CLIENT_SECRET` are literals. The file is gitignored and untracked, so
this is not an exposure, but it breaks the convention -- move them into op when
convenient. Note the original `credentials (1).json` may still be in
`~/Downloads`.

**An entry's `date` changed meaning on 2026-08-24: it is now the calendar date
at the DEPARTURE AIRPORT, not in UTC.** Entries written under the old convention
carry a UTC date and nothing rewrites them, so a pre-change entry that has not
yet resolved can match the wrong leg -- for an evening departure west of
Greenwich the two dates are a day apart, and the local reading of a UTC-dated
entry is the NEXT day's flight. Harmless in practice this time: the store was
empty when it deployed, and the only entry since was added under the new rule.
It is recorded because the same hazard returns for anyone restoring an old
tracked.json from a backup -- delete and re-add is the fix, as it is for every
other missing-field case below.

Two smaller shape changes landed with it, both additive: a card's `cs` is now
the ICAO callsign (`DAL1732`) rather than the IATA number typed into the form,
which is what lets the device find an airline logo tile at all; and
`aircraftType` (hexdb.io's ICAO type code, e.g. `B752`) is preferred over
`aircraftModel` for the card's aircraft line, falling back to the model name
when hexdb has nothing.

**No schema migration for stored entries.** A `TrackedEntry` written before a
field existed simply lacks it, and nothing backfills. This bit once already:
entries resolved before `aircraftModel` was added served a card with no aircraft
type until they were deleted and re-added, because that field is only ever set at
resolve time. Harmless while the store holds at most 20 short-lived entries --
delete and re-add is the fix -- but do not assume an old entry has new fields.

**Latent, not currently broken:** `normaliseNumber` in
`src/tracked/routes.ts` uses `^[A-Z0-9]{2,3}\d{1,4}$`, whose `{2,3}` is greedy --
on "BA181" it consumes "BA1" and leaves "81". That is harmless there because the
function never uses the captured split, only whether a letter is present. The
SAME shape in the card builder DID break airline lookup and was fixed by taking
the trailing digit run first. If anyone refactors `normaliseNumber` to use its
groups, this is waiting.

**The tracked marker no longer distinguishes an estimated position, by explicit
maintainer decision (2026-08-24).** It was a 3px amber bar down the left edge,
filled for a live fix and hollow for a dead-reckoned one; it is now a 1px white
border round the whole panel with `TRACKED` in the top-right, drawn the same way
either way. The maintainer was shown the trade-off -- that this is the one thing
the tracked design named as a risk ("dead-reckoned position mistaken for a fix",
see the 2026-08-24 spec) -- and chose it. NOTHING upstream changed: `pos_src` is
still computed, still on the wire, still rendered in words on the server's
watched-flights page. If it should come back on the panel, the cheap version is
a second word (`EST`) rather than a border style, because a 1px border has no
legible hollow variant.

Two things that entry fixes in passing: the marker now lives in
`displayFlightCard`, after the layout call, so it covers `displayTextOnlyCard`
too (the old bar sat in `drawLogoOrBadge`, which that layout never calls); and
the `TRACKED` word is drawn only on the Mini layout, gated on the same
`usesMiniCard()` predicate the dispatcher uses, because that is the only layout
that reserves columns for it -- on a 64x64 Stacked card it would land across the
centred logo. Other shapes get the border alone.

---

## 4. This session's commits (newest first)

**2026-08-24 --- merged to `main` as `eec3cb2` (48 commits), flashed and deployed.**

```
01ae579  docs(schedule): correct quiet-hours invariant + budgets  [see below]
631f6eb  fix(schedule): survive a bad REFRESH_QUIET_TZ, cold start [both were real bugs]
6128c0e  feat(schedule): pause the refresh between 00:00 and 06:00
e99129c  feat(schedule): quiet-hours and refresh-decision predicates
be431d0  feat(fetch): stop fetching while the panel is dark        [DEVICE-VERIFIED]
14e0647  feat(fetch): pure helper for the dark-panel decision
```

Two defects a whole-feature review caught that per-task review had not:
`REFRESH_QUIET_TZ` fed an unguarded `Intl.DateTimeFormat` on a floating promise, so
a one-character typo in `deploy.yml` killed the WHOLE server process (reproduced
against the built bundle: exit 1, `/up` gone); and `shouldRefresh` checked `quiet`
before the cold start, so a server booting inside the window with no table served
routeless flights until 06:00. Both fixed and re-verified.

Earlier session:

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

## 5. Logos — ⚠️ THE POLICY BELOW IS ALREADY VIOLATED. READ BEFORE PUSHING.

> **The trademarked tiles ARE committed, and they ARE on the public fork.** Found
> 2026-08-24 while cleaning duplicate files. Commit **`22cb724`** ("assets(logos):
> add and refresh bundled airline logo tiles", 2026-07-20, Charles Schwartz) added
> **exactly 131 tiles** -- the same count this policy says must never be committed --
> and it is an ancestor of `origin/main`, `origin/flightwall-mini-parity` and
> `origin/readme-fork-framing` on `github.com/chaim354/TheFlightWall_OSS`. So the set
> has been published for roughly a month.
>
> Corroborating counts: **153** `.rgb565` are tracked at HEAD against the ~100
> generated badges this section expects, and **nothing in that directory is locally
> modified any more** -- so the "modified locally, stays uncommitted" arrangement the
> policy describes no longer exists on disk either. (The 72 untracked `NAME 2.rgb565`
> files removed on 2026-08-24 were byte-identical copies of tracked originals; no
> artwork was lost with them.)
>
> **MAINTAINER DECISION NEEDED -- do not let an agent do this unprompted.** Undoing it
> means rewriting already-pushed history across at least three remote branches, or
> making the fork private, or deciding the exposure is acceptable. All three are the
> maintainer's call. Until one is made, treat the rules below as the INTENT, not as a
> description of the repository's actual state.

- **Real airline logo tiles are meant to be LOCAL-ONLY — never commit them.** The
  intent: the user's trademarked FlightAware/radarbox set stays uncommitted. Only ever
  `git add` logo files **by explicit path**; NEVER `git add firmware/data/logos/` or
  `git add -A`. (Generated badges ARE fine to track.) See the box above for why this
  currently does not match reality.
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

Host tests: `cd firmware && ./run_host_tests.sh` -- derives the suite list from
`test/test_*.cpp` and exits non-zero if any fails. (The hand-listed `for` loop this
replaces discarded each iteration's status and always exited 0.)
