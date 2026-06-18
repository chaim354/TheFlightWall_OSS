#pragma once

#include <Arduino.h>

struct StateVector
{
    String icao24;
    String callsign;
    double lon = NAN;
    double lat = NAN;
    double baro_altitude = NAN;
    bool on_ground = false;
    double velocity = NAN;
    double heading = NAN;
    double vertical_rate = NAN;
    double geo_altitude = NAN;
    int position_source = 0;
    int category = 0; // ADS-B emitter category (with extended=1); 8 = rotorcraft
    double distance_km = NAN;
    double bearing_deg = NAN;
};
