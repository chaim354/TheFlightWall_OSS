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

enum class TrackingMode : uint8_t
{
    Area = 0,   // Track everything within radius of a center point
    Flights = 1 // Track a specific list of flights by ident / callsign / tail
};

// Which fields are rendered on each flight card, in order. Toggled from web UI.
struct DisplayLayout
{
    bool showAirlineFlight = true; // "United UA123"
    bool showRoute = true;         // "KSFO>KJFK"
    bool showAircraft = true;      // "B739"
    bool showAltitude = false;     // "FL350" / "12,500ft"
    bool showSpeed = false;        // "451kt"
    bool showHeading = false;      // "HDG 094"
    bool showVerticalRate = false; // "+1200fpm"
};

struct AircraftFilters
{
    double minAltitudeFt = 0.0;       // Hide aircraft below this altitude (ft)
    double maxAltitudeFt = 60000.0;   // Hide aircraft above this altitude (ft)
    bool excludeOnGround = true;      // Hide aircraft reporting on_ground
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
    int16_t timezoneOffsetMinutes = 0; // offset from UTC for local time
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

    // ---- Tracking ----
    TrackingMode mode = TrackingMode::Area;
    double centerLat = 37.7749;
    double centerLon = -122.4194;
    double radiusKm = 10.0;
    std::vector<String> trackedFlights; // idents / callsigns / tails for Flights mode

    // ---- Display ----
    uint8_t brightness = 5;
    uint8_t textColorR = 255;
    uint8_t textColorG = 255;
    uint8_t textColorB = 255;
    uint8_t maxFlights = 5;        // up to N aircraft kept/cycled
    uint32_t cycleSeconds = 5;     // seconds per flight when cycling
    uint32_t fetchIntervalSeconds = 10;

    DisplayLayout layout;
    AircraftFilters filters;
    BrightnessSchedule schedule;

    // ---- Hardware: HUB75 panel geometry (web-editable; applied on restart) ----
    uint16_t panelResX = 64; // pixels wide per panel module
    uint16_t panelResY = 64; // pixels high per panel module
    uint8_t panelChain = 2;  // panels chained -> matrix width = panelResX * panelChain

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
