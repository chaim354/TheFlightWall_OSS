# TheFlightWall

TheFlightWall is an LED wall that shows live information about flights passing your window.

> **About this fork.** This project was **inspired by the original [TheFlightWall](https://github.com/AxisNimble/TheFlightWall_OSS)** (the commercial build sold at [theflightwall.com](https://theflightwall.com)), but it has since diverged almost entirely. The firmware has been essentially rewritten and now shares **almost none of the original code or components**: it drives a **HUB75 RGB matrix** (the original was a WS2812B panel wall), is configured entirely from a built-in **web page**, and uses a new data pipeline (OpenSky + adsbdb/hexdb, with optional AeroAPI or Flightradar24). Full credit for the original concept and build goes to its creators.

This build is at feature parity with the FlightWall Mini: two tracking modes, live flight metrics, filters, and a day/night brightness schedule — all controlled from the web UI, no app required. See [Configuration & Control](#configuration--control-web-ui).

# Component List

- **Display** — a **HUB75 RGB LED matrix**. The firmware targets the Mini's **128×64** geometry (e.g. two 64×64 panels chained, or a single 128×64), but tile size and chain length are set in the web UI, so other layouts work too. Any HUB75 panel supported by [ESP32-HUB75-MatrixPanel-DMA](https://github.com/mrcodetastic/ESP32-HUB75-MatrixPanel-DMA) should be fine.
- **Controller** — an ESP32 dev board. A plain ESP32 works; an **ESP32-S3 with PSRAM** is recommended for the extra headroom (larger displays, TLS). We originally used an [R32 D1](https://www.amazon.com/HiLetgo-ESP-32-Development-Bluetooth-Arduino/dp/B07WFZCBH8).
- **Level shifter** *(recommended)* — a fast push-pull **74HCT245 / 74AHCT245** on the HUB75 logic lines for a stable signal from the ESP32's 3.3 V. (A bidirectional I²C-type BSS138 shifter will **not** work — see [Unstable display?](#unstable-display-flicker--pixels-shifted-by-one).)
- **Power** — a **5 V power supply** sized to your panel. A 128×64 can draw up to ~8 A at full white and far less at normal brightness, so a 5 V 5–10 A supply is comfortable. Tie the panel and ESP32 grounds together.
- **Enclosure** — a frame or stand of your choice (3D-printed brackets, wood trim, or the panel's own frame).
- **(Optional) ambient light sensor** — an analog LDR, or an I²C **BH1750** / **TCS3472**, to auto-dim at night.

### Data services
- **[OpenSky](https://opensky-network.org/)** — live ADS-B positions (free, needs an OAuth client id/secret). *Default.*
- **[adsbdb.com](https://www.adsbdb.com/) + [hexdb.io](https://hexdb.io/)** — free route / airline / aircraft enrichment, no key. *Default.*
- **[FlightAware AeroAPI](https://www.flightaware.com/commercial/aeroapi/)** — optional paid enrichment for authoritative routes.
- **Flightradar24** — optional, keyless, **unofficial** position+route source (personal use only).

See [Data API Keys](#data-api-keys) and [`docs/data-sources.md`](docs/data-sources.md) for how each source is used, costs, and trade-offs.

# Hardware

## Dimensions

Depends on the panel's pixel pitch. A 128×64 build from two 64×64 panels is roughly:
- **P2.5** — ~320 × 160 mm (~12.6 × 6.3 in)
- **P3** — ~384 × 192 mm (~15.1 × 7.6 in)

> **Legacy note:** this project started as a large wall built from 20× 16×16 **WS2812B** panels (~63 in) with 3D-printed brackets and wooden supports. That single-data-line design is **no longer driven by this firmware** — it's HUB75 only now. The old build photo ([`images/led-panel-wiring-and-brackets.jpg`](images/led-panel-wiring-and-brackets.jpg)) and WS2812 wiring diagram ([`images/wiring-diagram.png`](images/wiring-diagram.png)) are kept for reference.

## Display: HUB75 RGB matrix

This firmware drives a **HUB75 RGB LED matrix** (like the 128×64 used by the FlightWall Mini), via the [ESP32-HUB75-MatrixPanel-DMA](https://github.com/mrcodetastic/ESP32-HUB75-MatrixPanel-DMA) library. Default geometry is a 64×64 panel ×2 chained = **128×64**; set your panel width/height and chain length from the web UI.

### HUB75 → ESP32 pin map
The data pins are the only compile-time hardware setting — edit them in [`firmware/config/HardwareConfiguration.h`](firmware/config/HardwareConfiguration.h) to match your wiring:

| HUB75 | GPIO | HUB75 | GPIO | HUB75 | GPIO |
|---|---|---|---|---|---|
| R1 | 25 | R2 | 14 | A | 23 |
| G1 | 26 | G2 | 12 | B | 19 |
| B1 | 27 | B2 | 13 | C | 5 |
| CLK | 16 | LAT | 4 | D | 17 |
| OE | 15 | | | E | 32 |

`E` is only needed for 1/32-scan (64-row) panels; set it to `-1` for 32-row panels. Power the panel from the external **5V** supply with grounds tied to the ESP32.

### Unstable display? (flicker / pixels shifted by one)
Driving HUB75 directly at the ESP32's 3.3 V can be marginal. The web UI's **Hardware → Signal tuning** section exposes fixes (applied on restart):
- **Clock phase** — turn it *off* first; this usually fixes an off-by-one pixel shift.
- **Driver chip** — many 128×64 panels use **FM6126A**; selecting it fixes flicker/garbage if the panel doesn't init as a plain shift register.
- **I2S clock** — drop to 8 MHz for the most stable signal.

The robust hardware fix is a **fast push-pull level shifter (74HCT245 / 74AHCT245)** on the 13–14 logic lines. Note: a *bidirectional I2C* level shifter (BSS138 type) will **not** work for HUB75 — it's too slow and has too few channels.

![HUB75 Wiring Diagram](images/hub75-wiring.svg)

# Data and Software

## Data API Keys

The data for this project consists of two parts:
1. **Flight positions & callsigns** — public [ADS-B](https://en.wikipedia.org/wiki/Automatic_Dependent_Surveillance%E2%80%93Broadcast) data. Selectable in the web UI:
   - **[OpenSky](https://opensky-network.org)** — *default, free, needs an OAuth client id/secret.*
   - **Flightradar24** — *opt-in, no key.* An **unofficial** scrape of fr24.com's internal `feed.js` — the same JSON the live map uses. One call returns positions **and** route/airline/aircraft together, so no separate enrichment lookup is needed and its routes handle diversions/non-scheduled traffic that the free enrichment databases miss. Trade-offs: it **violates Flightradar24's Terms of Service** (personal/educational use only — see business@fr24.com for commercial), the endpoint is undocumented and can break or rate-limit, and it parses the whole area in one shot — so it's intended for the **ESP32-S3 (PSRAM)** and a modest radius. OpenSky remains the default; this is never on unless you select it.
2. **Flight enrichment** — airline, route (origin/destination), and aircraft type. Used when the position source doesn't already provide it (OpenSky). Selectable in the web UI:
   - **[adsbdb.com](https://www.adsbdb.com/)** — *default, free, no API key.* Callsign → route + airline, ICAO24 → aircraft type.
   - **[FlightAware AeroAPI](https://flightaware.com/aeroapi)** — paid; optional. Can be the primary source, or just a **backup** that only fires when adsbdb misses a flight (so you pay only for the gaps).
   - **Off** — show callsign only.

Enrichment results are **cached per flight leg** (default 10 min) so loitering planes aren't re-queried every cycle. Out of the box the wall costs **$0** for enrichment — you only need the OpenSky credentials. Enter everything later in the web UI — you do **not** have to hardcode anything.

> **📖 See [docs/data-sources.md](docs/data-sources.md)** for the full rundown: every position and enrichment source, approximate monthly costs, how to configure each, and the trade-offs of the opt-in Flightradar24 source (including its Terms-of-Service and memory caveats).

### Setting up OpenSky
1. Register for an [OpenSky](https://opensky-network.org/) account
2. Go to your [account page](https://opensky-network.org/my-opensky/account)
3. Create a new API client and note the `client_id` and `client_secret`

### Setting up AeroAPI
1. Go to the [FlightAware AeroAPI](https://flightaware.com/aeroapi) page and create a personal account
2. From the dashboard, open **API Keys**, click **Create API Key** and follow the steps
3. Copy the generated key

## Software Setup

### Build and flash with PlatformIO

The firmware can be built and uploaded to the ESP32 using [PlatformIO](https://platformio.org/).

1. **Install PlatformIO**:
   - Install [VS Code](https://code.visualstudio.com/)
   - Add the [PlatformIO IDE extension](https://platformio.org/install/ide?install=vscode)

2. **(Optional) Bake in your WiFi at flash time** — instead of using the browser setup AP, copy [`firmware/config/Secrets.h.example`](firmware/config/Secrets.h.example) to `firmware/config/Secrets.h` and fill in your WiFi (and optionally API) credentials:
   ```cpp
   #define FW_WIFI_SSID      "YourWiFiName"
   #define FW_WIFI_PASSWORD  "YourWiFiPassword"
   ```
   `Secrets.h` is **gitignored**, so your password is never committed. These values seed the device on first boot; afterwards everything is managed from the web UI. (The data pin in [HardwareConfiguration.h](firmware/config/HardwareConfiguration.h) is the only other compile-time setting.)

3. **Upload the firmware and the web UI** (two artifacts). From the `firmware` folder:
   ```bash
   pio run --target upload      # flash the firmware
   pio run --target uploadfs    # flash the web UI (LittleFS image in firmware/data/)
   ```
   In the PlatformIO IDE these are **Upload** and **Upload Filesystem Image** under the project tasks. Run `uploadfs` once (and again whenever `firmware/data/index.html` changes).

## Configuration & Control (Web UI)

There is no app to install — the device hosts its own configuration page.

### First-time setup (WiFi provisioning)
On first boot (no WiFi saved yet) the wall starts a setup access point named **`FlightWall-Setup`**. Connect your phone/laptop to it and a captive-portal config page opens automatically (or browse to `http://192.168.4.1`). Enter your WiFi + API keys, save, and restart. After that the wall joins your network — the display shows its IP on boot, and you can reach the same page at **`http://flightwall.local/`** (mDNS) or `http://<that-ip>/`.

### Set credentials over USB serial (no recompile)
After flashing, you can also configure the device from the serial monitor — handy for setting WiFi without the setup AP or editing files:
```bash
pio device monitor -b 115200
```
Then type commands (`help` lists them all):
```
wifi MyNetwork MyPassword
restart
```
Other commands: `status`, `opensky <id> <secret>`, `aeroapi <key>`, `enrich <adsbdb|aeroapi|off>`, `mode <area|flights>`, `loc <lat> <lon> <radiusKm>`, `light` / `light watch` (live sensor reading for calibration), `get`, `set <json>`, `erase`. Changes are saved to the device immediately. (The position source — OpenSky vs Flightradar24 — is set from the web UI.)

### What you can configure from the web page
- **WiFi** — scan + select your network (changes apply after a restart).
- **API keys & sources** — OpenSky client id/secret and the FlightAware AeroAPI key; dropdowns to pick the **position source** (OpenSky / Flightradar24) and **enrichment source** (adsbdb / AeroAPI / off).
- **Tracking mode**:
  - **Area** — show everything within a radius of a center point (your home/window). An **Auto-detect** button fills the center from IP geolocation (free, no key, approximate — review before saving), with an optional "auto-detect on every boot" toggle.
  - **Flights** — track a specific list of flights by flight number, callsign, or tail.
- **Display** — brightness, text color, max flights to cycle, seconds per flight, fetch interval, which **fields** appear on each card (airline+flight, route, aircraft, **altitude, speed, heading, vertical rate**), and the **no-flights screen** (clock / aviation fun facts).
- **Filters** — altitude band, hide aircraft on the ground, and an airline allow-list.
- **Brightness schedule** — separate day/night brightness with configurable night hours, using a **POSIX timezone string** (e.g. `EST5EDT,M3.2.0,M11.1.0`) so daylight-saving transitions are handled automatically.
- **Ambient light sensor** — optionally auto-blank (or dim) the panel when the room goes dark. Supports an analog photoresistor/LDR on an **ADC1** pin (34/35/36/39/33 — ADC2 can't be used with WiFi on), or an I²C **BH1750** lux sensor or **TCS3472** RGBC sensor on SDA=21/SCL=22. Threshold + hysteresis are tunable, and the web UI shows the live reading for calibration.
- **Hardware** — tile size and tile count, so you can match any panel layout (changes apply after a restart).
- **Live status** — current connection, mode, and the flights currently on the wall, each with its **distance** (the list is ordered nearest-first).

Settings are stored on the device (LittleFS) and survive reboots — no re-flashing needed to change anything except the data pin.

## Airline logos

The wall renders a **Mini-style flight card**: an airline logo tile on the left, then the flight number, route, aircraft, and your chosen metrics on the right. Logos are 16×16 tiles stored on the device at `firmware/data/logos/<ICAO>.rgb565` (keyed by the airline's ICAO code, e.g. `UAL.rgb565`).

- A bundled set of **150+ carriers worldwide** (passenger and cargo) ships in the repo as brand-colored code-badge tiles — the airline's 2-letter code on its brand color, not trademarked logo artwork. Airlines without a tile fall back to the same brand-style badge generated on the fly.
- They're flashed as part of the LittleFS image (`pio run -t uploadfs`).

### Add or replace logos
- **Use real artwork** (one airline) — convert a PNG you have rights to use, then re-flash the filesystem:
  ```bash
  pip install pillow
  python3 tools/png_to_rgb565.py my_airline.png firmware/data/logos/SWA.rgb565 --size 16
  pio run -t uploadfs   # from the firmware/ folder
  ```
- **Batch-convert a whole folder** of `<ICAO>.png` logos at once:
  ```bash
  python3 tools/convert_logo_folder.py ~/airline_logos firmware/data/logos --size 16
  ```
- **Regenerate the bundled code-badge tiles** (no dependencies): edit the `AIRLINES` table in [`tools/gen_starter_logos.py`](tools/gen_starter_logos.py) and run `python3 tools/gen_starter_logos.py`.

Tiles are a tiny raw format: `uint16 width, uint16 height`, then `width×height` little-endian RGB565 pixels. They can be any size up to 64×64. **For a 128×64 panel use `--size 32`** (the big-panel layout draws a 32×32 logo); the renderer auto-fits whatever size you provide. The bundled brand badges are 16×16 and get upscaled when needed.

### Layouts by panel size
The flight card adapts to the panel: **128×64** uses a "Mini" layout (32px logo + airline/route/aircraft beside it + two full-width metric rows: `Alt:4.1kft,Spd:258mph` / `Trk:263deg,Vr:-18ft/s`, with IATA airport codes); **64×64** stacks the logo on top; wide/short panels (64×32, 128×32, 160×32) put the logo at left with text beside it.

# Credits

This project was inspired by the original [TheFlightWall](https://github.com/AxisNimble/TheFlightWall_OSS) — full credit to its creators for the concept and the build (their [viral build video](https://www.instagram.com/p/DLIbAtbJxPl)). If you'd rather buy a finished, polished display than build your own, check out their official product at **[theflightwall.com](https://theflightwall.com)** ([@theflightwall](https://www.instagram.com/theflightwall)).