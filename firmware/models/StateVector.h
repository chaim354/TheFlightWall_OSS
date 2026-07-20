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

    // Inline enrichment. OpenSky leaves these empty (route/type/airline come from a
    // separate adsbdb/hexdb lookup). Sources that carry route data in the position
    // feed — e.g. FlightRadar24Fetcher — fill them, and Area mode uses them directly
    // instead of opening a per-flight enrichment connection. IATA codes here; the
    // enrichment consumer maps them to display names.
    String origin_iata;
    String dest_iata;
    String aircraft_type;         // ICAO type, e.g. "B738"
    String airline_icao;          // operator ICAO, e.g. "AAL"
    bool has_inline_enrichment = false;
};
