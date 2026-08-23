#pragma once

#include <Arduino.h>

namespace UserConfiguration
{
    // Location configuration (default seed; change to your area or use the web UI / auto-detect).
    // Defaults to JFK airport's reference point — a generic landmark, not anyone's home.
    static const double CENTER_LAT = 40.6413; // JFK (KJFK) airport reference point
    static const double CENTER_LON = -73.7781;
    static const double RADIUS_KM = 10.0; // Search radius in km (memory-safe; raise in UI if stable)

    // Display customization
    // Brightness controls overall display brightness (0-255)
    static const uint8_t DISPLAY_BRIGHTNESS = 20;
    // Also mirrored by Settings.h's initialiser: seedDefaults() reads these constants,
    // but a default-constructed Settings uses the header's. They must agree.
    //
    // 12, not 8. The panel shows one flight at a time and cycles, so this sets
    // the length of the carousel rather than how much is on screen -- the cost
    // of raising it is that each flight gets proportionally less airtime, not
    // more pixels. Server-side it is free: /v1/flights caps at MAX_FLIGHTS_CEILING
    // = 40, and 12 flights is ~3KB of JSON, which lands in PSRAM rather than
    // internal RAM (over the 4096-byte CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL
    // threshold). What DOES scale with this is the logo LRU that
    // Hub75Display::applySettings() resizes, so a much larger value should be
    // checked against largestInternal (now reported by /api/status) rather than
    // assumed safe.
    static const uint8_t MAX_FLIGHTS = 12;

    // RGB color for all text rendering on the LED matrix
    static const uint8_t TEXT_COLOR_R = 255;
    static const uint8_t TEXT_COLOR_G = 255;
    static const uint8_t TEXT_COLOR_B = 255;
}
