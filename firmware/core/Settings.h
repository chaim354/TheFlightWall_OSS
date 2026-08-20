/*
Purpose: Runtime, web-editable settings for TheFlightWall.

Replaces the compile-time `config/*.h` constants as the source of truth at run
time. The static `config/*.h` namespaces are still used to SEED the defaults the
first time the device boots, after which everything is read from / written to a
JSON document persisted on LittleFS (`/settings.json`).

Flow:
- `Settings::begin()` mounts LittleFS and loads `/settings.json` (or seeds it
  from compile-time defaults on first boot).
- The web UI reads (`toJson`) and writes (`fromJson` + `save`) this struct.
- main.cpp / fetchers / display read fields directly from the global `g_settings`.
*/
#pragma once

#include <Arduino.h>
#include <vector>
#include "config/HardwareConfiguration.h" // board-guarded default light-sensor pin

enum class TrackingMode : uint8_t
{
    Area = 0,   // Track everything within radius of a center point
    Flights = 1 // Track a specific list of flights by ident / callsign / tail
};

enum class EnrichmentSource : uint8_t
{
    Adsbdb = 0, // free, no key (adsbdb.com)
    AeroApi = 1, // paid FlightAware AeroAPI (needs key)
    Off = 2      // no enrichment; callsign-only cards
};

// Where Area-mode position (state-vector) data comes from.
enum class PositionSource : uint8_t
{
    OpenSky = 0,       // default: stable, official, OAuth-key'd public API
    FlightRadar24 = 1, // opt-in UNOFFICIAL scrape of fr24.com's feed.js. Carries
                       // route/aircraft/airline inline (no separate enrichment
                       // call), but violates FR24 ToS and can break/rate-limit.
                       // Never the default; intended for personal use on the S3.
};

enum class LightSensorType : uint8_t
{
    Analog = 0,  // photoresistor/LDR on an ADC1 pin (analogRead)
    BH1750 = 1,  // I2C lux sensor; reading is lux
    TCS3472 = 2, // I2C RGBC sensor (TCS34725/27); reading is the raw Clear channel
};
// I2C pins for BH1750/TCS3472 come from HardwareConfiguration (board-guarded).
// NOTE: lightDarkThreshold's UNITS depend on this type — raw ADC counts (0-4095),
// lux, or raw Clear counts respectively. They are not interchangeable, and the 500
// default only ever made sense for Analog (500 lux is a lit office). Tune it against
// the live `lightLevel` in /api/status rather than by reasoning about the number.

// Which fields are rendered on each flight card, in order. Toggled from web UI.
struct DisplayLayout
{
    bool showAirlineFlight = true; // "United UA123"
    bool showRoute = true;         // "KSFO>KJFK"
    bool showAircraft = true;      // "B739"
    bool showAltitude = true;      // "FL350" / "12,500ft"
    bool showSpeed = true;         // "451kt"
    bool showHeading = true;       // "HDG 094"
    bool showVerticalRate = true;  // "+1200fpm"
    bool flightNumberOverVr = true;  // show the flight number in the vertical-rate slot
    // What to show when there are zero flights:
    //   "dots", "clock", "funfact", "clockfact" (default — alternates the two)
    String noFlightsMode = "clockfact";
};

struct AircraftFilters
{
    double minAltitudeFt = 0.0;       // Hide aircraft below this altitude (ft)
    double maxAltitudeFt = 60000.0;   // Hide aircraft above this altitude (ft)
    bool excludeOnGround = true;      // Hide aircraft reporting on_ground
    bool showGeneralAviation = false; // Show GA/private (non-airline-format) flights in leftover slots
    bool hideCargo = false;           // Hide known cargo/freight operators
    // If non-empty, only show flights whose operator (ICAO/IATA) is in this list.
    std::vector<String> airlineAllowList;
};

struct BrightnessSchedule
{
    bool enabled = false;
    uint8_t dayBrightness = 40;
    uint8_t nightBrightness = 5;
    uint8_t nightStartHour = 22; // local hour [0-23] when night brightness begins
    uint8_t nightEndHour = 7;    // local hour [0-23] when day brightness resumes
    // POSIX TZ string, e.g. "EST5EDT,M3.2.0,M11.1.0". Replaces a fixed minute offset,
    // which had no DST information: it silently ran an hour wrong for half the year and
    // dragged the night window below along with it. libc handles the transitions.
    String timezone = "UTC0";
};

struct Settings
{
    // ---- Network ----
    String wifiSsid;
    String wifiPassword;

    // ---- API credentials ----
    String openSkyClientId;
    String openSkyClientSecret;
    String aeroApiKey;

    // ---- Position source (Area mode) ----
    PositionSource positionSource = PositionSource::OpenSky;

    // ---- Flight enrichment (route/airline/aircraft) ----
    EnrichmentSource enrichmentSource = EnrichmentSource::Adsbdb;
    uint32_t enrichmentCacheSeconds = 600; // cache per-leg lookups (cuts requests)
    // When the free source (adsbdb) is primary and misses a flight, fall back to
    // AeroAPI (only if a key is configured). Keeps AeroAPI as a backup, not the default.
    bool enrichmentFallbackToAeroApi = true;

    // ---- Tracking ----
    TrackingMode mode = TrackingMode::Area;
    double centerLat = 37.7749;
    double centerLon = -122.4194;
    double radiusKm = 10.0;
    bool autoLocateOnBoot = false; // set center from IP geolocation each boot
    std::vector<String> trackedFlights; // idents / callsigns / tails for Flights mode

    // ---- Display ----
    uint8_t brightness = 20;
    uint8_t textColorR = 255;
    uint8_t textColorG = 255;
    uint8_t textColorB = 255;
    uint8_t maxFlights = 8;        // up to N aircraft kept/cycled
    uint32_t cycleSeconds = 3;     // seconds per flight when cycling
    uint32_t fetchIntervalSeconds = 30;

    DisplayLayout layout;
    AircraftFilters filters;
    BrightnessSchedule schedule;

    // ---- Physical buttons ----
    // Pins are compile-time in HardwareConfiguration (a wiring choice, like HUB75 —
    // not runtime-editable, so the web UI cannot point them at something harmful).
    // Default ON. Safe with no hardware attached: INPUT_PULLUP makes an unwired pin
    // read HIGH (= released), so it produces no events.
    bool buttonsEnabled = true;

    // ---- Ambient light sensor (auto-off / dim when the room is dark) ----
    // Default ON as a TCS3472. Safe with no sensor attached: the chip-ID check fails,
    // readSensor() returns -1, and update() fail-safes to "lit" so the panel stays on.
    bool lightSensorEnabled = true;
    LightSensorType lightSensorType = LightSensorType::TCS3472;
    // ADC1 pin for the analog sensor. Board-guarded default: 34 is ADC1 on the classic
    // ESP32 but is octal PSRAM on an S3 N16R8. LightSensor::begin() range-checks it.
    uint8_t lightSensorPin = HardwareConfiguration::LIGHT_ANALOG_PIN;
    uint16_t lightDarkThreshold = 500;  // below this = dark; UNITS depend on sensor type
    uint16_t lightHysteresis = 150;     // must rise this far above threshold to turn back on
    bool lightSensorDimInstead = false; // false = blank the panel, true = dim it
    uint8_t lightDimBrightness = 3;     // brightness used when dimming in the dark

    // ---- Hardware: HUB75 panel geometry (web-editable; applied on restart) ----
    uint16_t panelResX = 64; // pixels wide per panel module
    uint16_t panelResY = 64; // pixels high per panel module
    uint8_t panelChain = 2;  // panels chained -> matrix width = panelResX * panelChain

    // HUB75 signal-integrity tuning (try these if pixels flicker / shift by one):
    bool panelClkPhase = false;       // default off — fixes the off-by-one pixel shift on most panels
    uint8_t panelI2sSpeedMhz = 8;     // 8 / 16 / 20 — lower = more stable at 3.3V
    uint8_t panelLatchBlanking = 1;   // raise to reduce ghosting (some panels dislike >1)
    String panelDriverChip = "shift"; // shift | fm6124 | fm6126a | icn2038s | mbi5124

    // ---- Persistence / lifecycle ----
    bool begin();          // mount FS + load (or seed) settings
    bool load();           // read /settings.json
    bool save() const;     // write /settings.json
    void seedDefaults();   // populate from compile-time config/*.h

    String toJson() const;            // serialize for the web UI / persistence
    bool fromJson(const String &in);  // apply an incoming JSON document

    bool hasWifi() const { return wifiSsid.length() > 0; }
};

extern Settings g_settings;
