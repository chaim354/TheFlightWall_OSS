# ESP32 → ESP32-S3-DevKitC-1 N16R8 Migration

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

1. **Wire the HUB75 panel** to S3 GPIOs (see pin map). Update
   `firmware/config/HardwareConfiguration.h`.
2. **Confirm PSRAM** at boot: add `Serial.printf("PSRAM: %u\n", ESP.getPsramSize());`
   — expect ~8 MB. The existing `[heapdiag]` lines will then show `largest8`
   stop being the bottleneck.
3. **Restore full color depth**: the S3 env intentionally omits
   `-D PIXEL_COLOR_DEPTH_BITS=6`, so it builds at 8-bit. Nothing to do.
4. **Flash**: `pio run -e esp32s3 -t upload` then `pio run -e esp32s3 -t uploadfs`.
5. **Re-tune signal integrity** for the S3's LCD_CAM HUB75 backend (clkphase,
   latch_blanking, i2sspeed) — usually *better* than the original I2S path.
6. Verify enrichment is rock-solid (no `GET -1`) and remove the `[heapdiag]`
   instrumentation once confirmed.

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
- **Framebuffer in PSRAM** — the S3 HUB75 backend can place the DMA framebuffer
  in PSRAM for large panels; for 128×64 it's optional (internal is fine) but
  frees ~64 KB internal if you want it.
- **Bigger LittleFS** — swap `default_16MB.csv` for an FS-heavy custom partition
  table so all airline logos + web assets fit with room to spare (the 4 MB part
  on the plain ESP32 forced `huge_app.csv`).
- **OTA updates** — 16 MB easily fits dual app slots; wire up ArduinoOTA.
