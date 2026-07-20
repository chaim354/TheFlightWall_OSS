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
    static const uint8_t MAX_FLIGHTS = 8;

    // RGB color for all text rendering on the LED matrix
    static const uint8_t TEXT_COLOR_R = 255;
    static const uint8_t TEXT_COLOR_G = 255;
    static const uint8_t TEXT_COLOR_B = 255;
}
