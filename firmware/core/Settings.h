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
#include "config/HardwareConfiguration.h" // board-guarded pins + panel geometry
#include "config/UserConfiguration.h"     // location, brightness, colours, carousel size
#include "config/TimingConfiguration.h"   // fetch cadence + display cycle

// The initialisers below are THE defaults. seedDefaults() resets to them via
// `*this = Settings()` and then overlays only the five credentials that live in
// Secrets.h -- so a field added to this struct is in the reset path
// automatically. It used to be a hand-maintained second copy in Settings.cpp,
// which had already drifted (centerLat/centerLon said San Francisco here and
// JFK there) and had silently omitted serverUrl and positionSource entirely.
// Name the config constant rather than restating its value: a literal here is
// how that drift starts.
//
// WiFiConfiguration.h / APIConfiguration.h are deliberately NOT included -- they
// pull in Secrets.h, and this header is included by nearly every translation
// unit. Keeping credential seeding in the .cpp confines the baked-in password to
// one TU.

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
    AdsbLol = 2,       // keyless community ADS-B aggregator. No account, no ToS
                       // problem. Carries ICAO type, registration and a
                       // precomputed distance/bearing inline, so it replaces the
                       // per-flight aircraft lookup as well as the position feed.
                       // Carries NO route -- enrichment still runs for that.
    FlightWallServer = 3, // the FlightWall server does the fetching, joining and
                          // ETA maths and returns a display-ready list. One HTTP
                          // call per cycle instead of up to 1 + 2*maxFlights.
                          // Needs serverUrl; falls back to AdsbLol if unreachable.
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
    bool showEta = true;           // "~1h05" / "LANDING"
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
    // Base URL of the FlightWall server, e.g. "https://flightwall.example.workers.dev".
    // Stored without a trailing slash (normalised on load). Empty means the
    // server source is unusable and the fetcher falls back to AdsbLol.
    String serverUrl;

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
    double centerLat = UserConfiguration::CENTER_LAT;
    double centerLon = UserConfiguration::CENTER_LON;
    double radiusKm = UserConfiguration::RADIUS_KM;
    bool autoLocateOnBoot = false; // set center from IP geolocation each boot
    std::vector<String> trackedFlights; // idents / callsigns / tails for Flights mode

    // ---- Display ----
    uint8_t brightness = UserConfiguration::DISPLAY_BRIGHTNESS;
    uint8_t textColorR = UserConfiguration::TEXT_COLOR_R;
    uint8_t textColorG = UserConfiguration::TEXT_COLOR_G;
    uint8_t textColorB = UserConfiguration::TEXT_COLOR_B;
    uint8_t maxFlights = UserConfiguration::MAX_FLIGHTS; // length of the carousel, not what is on screen
    uint32_t cycleSeconds = TimingConfiguration::DISPLAY_CYCLE_SECONDS;
    uint32_t fetchIntervalSeconds = TimingConfiguration::FETCH_INTERVAL_SECONDS;

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
    uint16_t panelResX = HardwareConfiguration::PANEL_RES_X; // pixels wide per panel module
    uint16_t panelResY = HardwareConfiguration::PANEL_RES_Y; // pixels high per panel module
    uint8_t panelChain = HardwareConfiguration::PANEL_CHAIN;  // panels chained -> matrix width = panelResX * panelChain

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

    // FULL serialization, secrets included. This is the PERSISTENCE format --
    // save() writes it to /settings.json -- and it must stay complete.
    String toJson() const;

    // The same document with the three secrets REDACTED: wifiPassword,
    // openSkyClientSecret and aeroApiKey are replaced by `<name>Set` booleans.
    //
    // A sibling rather than a flag inside toJson(), because toJson() is
    // simultaneously the wire format and the persistence format -- one
    // serializer, two audiences with incompatible requirements. Masking inside
    // it would write masked values to flash.
    //
    // GET /api/settings served the full document, unauthenticated, to any LAN
    // peer. The UI does not need the values back: it assigns them into
    // type="password" inputs and nothing displays, validates, compares or
    // computes on them. The booleans are enough to show whether each is set.
    String toJsonPublic() const;
    bool fromJson(const String &in);  // apply an incoming JSON document

private:
    // mutable: save() is const, and this is bookkeeping about persistence
    // rather than part of the settings themselves.
    mutable bool _dirty = false;
    String serialize(bool redactSecrets) const;

public:

    bool hasWifi() const { return wifiSsid.length() > 0; }

    // DEFERRED-WRITE BOOKKEEPING.
    //
    // Button-driven changes are coalesced rather than written on every press: a
    // brightness ramp touches this struct on every rung and save() rewrites the
    // whole file, so main.cpp debounces ~10s. The flag lives HERE rather than
    // beside that timer because the thing that has to consult it -- "am I about
    // to reboot with an unsaved change?" -- happens in three translation units,
    // and two of them cannot see main.cpp's statics. Both restart paths used to
    // simply drop the pending write: press the mode button, hit Restart in the
    // web UI within ten seconds, and noFlightsMode reverted.
    //
    // main.cpp still owns WHEN to coalesce; this owns WHETHER anything is owed.
    void markDirty() { _dirty = true; }
    bool dirty() const { return _dirty; }
};

extern Settings g_settings;
