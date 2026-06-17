#pragma once

#include <Arduino.h>

struct StateVector
{
    String icao24;
    String callsign;
    String origin_country;
    long time_position = 0;
    long last_contact = 0;
    double lon = NAN;
    double lat = NAN;
    double baro_altitude = NAN;
    bool on_ground = false;
    double velocity = NAN;
    double heading = NAN;
    double vertical_rate = NAN;
    long sensors = 0;
    double geo_altitude = NAN;
    String squawk;
    bool spi = false;
    int position_source = 0;
    int category = 0; // ADS-B emitter category (with extended=1); 8 = rotorcraft
    double distance_km = NAN;
    double bearing_deg = NAN;
};
