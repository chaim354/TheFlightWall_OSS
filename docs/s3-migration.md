# ESP32 → ESP32-S3-DevKitC-1 N16R8 Migration

> **Dated record, not living documentation.** Accurate as of 2026-08; later
> changes are deliberately NOT backported. Correcting it to match current
> reality would falsify the record. Supersede it with a newer document instead.

Staged plan to move FlightWall OSS from the plain ESP32 (`esp32dev`) to an
**ESP32-S3-DevKitC-1 N16R8** (16 MB flash + 8 MB octal PSRAM). The build env
`[env:esp32s3]` is already in `platformio.ini`. Nothing here is wired to
hardware yet — work the checklist when the board arrives.

## Why migrate

The plain ESP32 fails TLS enrichment handshakes intermittently: free heap is
healthy (~120 KB) but the **largest contiguous internal block is only ~40 KB**,
right at the edge of the two ~16 KB buffers an mbedTLS handshake needs. Under
fragmentation it dips below the line → `mbedTLS -32512` → `? → ?`.

On the S3, arduino-esp32 is built with `CONFIG_SPIRAM_USE_MALLOC=y` and a
`MALLOC_ALWAYSINTERNAL` threshold of 16 KB, so **allocations ≥16 KB spill to the
8 MB PSRAM automatically**. The TLS buffers leave internal RAM entirely and the
constraint disappears — no color-depth compromise, lots of headroom for future
features. Enabling PSRAM needs only the board config below; **no IDF rebuild.**

## Checklist

1. **HUB75 pins** are already in `firmware/config/HardwareConfiguration.h` behind a
   `#if defined(CONFIG_IDF_TARGET_ESP32S3)` guard (the table below). **Verify they
   match your actual wiring** before powering the panel.
2. **Confirm PSRAM** at boot: `Serial.printf("PSRAM: %u\n", ESP.getPsramSize());` —
   expect ~8 MB. The `[heapdiag]` lines now report **internal** RAM (`largestInternal`,
   `psramFree`), so you'll see internal headroom *rise* once TLS spills to PSRAM. If
   `getPsramSize()` is 0, `memory_type` is wrong → boot loop territory.
3. **Restore full color depth**: the S3 env omits `-D PIXEL_COLOR_DEPTH_BITS=6`, so it
   builds at 8-bit automatically. Nothing to do.
4. **Set the panel clock for S3**: on the LCD_CAM backend, `panelI2sSpeedMhz` is
   bucketed (≤10→10 MHz, <20→16 MHz, else ~22 MHz). The persisted default of **8**
   lands in the *slowest* 10 MHz bucket → flicker on a 64-row panel. Set
   **15 or 16** in the web UI (or re-seed it) after first boot.
5. **Flash**: `pio run -e esp32s3 -t upload` then `pio run -e esp32s3 -t uploadfs`,
   then re-enter WiFi/API creds via the `FlightWall-Setup` AP (the FS wipe is expected;
   see settings→NVS note below to stop that for good). Ensure `config/Secrets.h` exists.
6. **Re-tune signal integrity** for the LCD_CAM backend (clkphase, latch_blanking,
   panel clock) — usually *better* than the original I2S path. Keep `double_buff` on.
7. Verify enrichment is rock-solid (no `GET -1`), confirm `largestInternal` grew, then
   remove the `[heapdiag]` instrumentation.

**Config already corrected in `[env:esp32s3]`** (from the migration audit): custom
`partitions_16MB.csv` (not the wasteful dual-6 MB `default_16MB`), `board_upload.maximum_size
= 16777216` (the stock `esp32-s3-devkitc-1` profile is the N8/8 MB variant), `qio_opi`
PSRAM, and a note to use **arduino-esp32 3.x** (pioarduino fork if your `espressif32`
platform is older) — the S3 LCD_CAM + octal PSRAM paths need it.

## HUB75 pin remap (recommended starting map)

The S3's LCD_CAM peripheral can route HUB75 to almost any GPIO. **Avoid** these:
- **GPIO 33–37** — used by the **N16R8 octal PSRAM** (do NOT use).
- **GPIO 26–32** — SPI flash.
- **GPIO 0, 3, 45, 46** — strapping pins.
- **GPIO 19, 20** — native USB (keep free for USB-CDC flashing/serial).
- **GPIO 43, 44** — UART0 (serial console).

A safe map using only free pins (adjust to your wiring):

| HUB75 | GPIO | HUB75 | GPIO |
|-------|------|-------|------|
| R1    | 4    | A     | 10   |
| G1    | 5    | B     | 11   |
| B1    | 6    | C     | 12   |
| R2    | 7    | D     | 13   |
| G2    | 8    | E     | 14   |
| B2    | 9    | LAT   | 15   |
| CLK   | 17   | OE    | 16   |

(E is only needed for 1/32-scan 64-high panels — which this is.)

## Optional optimizations (after it boots)

- **ArduinoJson in PSRAM** — give the documents a PSRAM allocator so even the
  small parse buffers leave internal RAM:
  ```cpp
  struct PsramAllocator {
    void* allocate(size_t n)   { return heap_caps_malloc(n, MALLOC_CAP_SPIRAM); }
    void  deallocate(void* p)  { heap_caps_free(p); }
    void* reallocate(void* p, size_t n) { return heap_caps_realloc(p, n, MALLOC_CAP_SPIRAM); }
  };
  JsonDocument doc{ PsramAllocator{} };   // or BasicJsonDocument in older API
  ```
- **Logo tiles cached in PSRAM** — preload the `.rgb565` tiles into a PSRAM map
  at boot instead of reading LittleFS on every render (fixes the per-frame
  `littlefs/logos/...` read + the missing-tile log spam).
- **Framebuffer stays INTERNAL — do NOT move it to PSRAM.** The S3 backend *can*
  put the DMA framebuffer in PSRAM, but PSRAM caps the pixel clock to ~10–13 MHz
  (vs 20 MHz internal) → visible flicker, and it also overrides `panelI2sSpeedMhz`.
  For 128×64 the framebuffer fits internal comfortably; spend PSRAM on TLS/JSON/
  caches instead. (The library author calls the PSRAM-framebuffer path pointless
  for anything but very long chains.)
- **Bigger LittleFS** — swap `default_16MB.csv` for an FS-heavy custom partition
  table so all airline logos + web assets fit with room to spare (the 4 MB part
  on the plain ESP32 forced `huge_app.csv`).
- **OTA updates** — 16 MB easily fits dual app slots; wire up ArduinoOTA.
