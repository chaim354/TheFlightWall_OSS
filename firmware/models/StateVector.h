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
    int category = 0; // ADS-B emitter category (with extended=1); 8 = rotorcraft
    double distance_km = NAN;
    double bearing_deg = NAN;

    // Inline enrichment. OpenSky leaves these empty (route/type/airline come from a
    // separate adsbdb/hexdb lookup). Sources that carry this data in the position
    // feed — e.g. FlightRadar24Fetcher — fill whichever of these fields they supplied,
    // and Area mode overlays them onto the result regardless of whether a network
    // lookup also ran. IATA codes here; the enrichment consumer maps them to display
    // names. See hasInlineRoute() below for when a route in the feed skips that
    // lookup entirely.
    String origin_iata;
    String dest_iata;
    String aircraft_type;         // ICAO type, e.g. "B738"
    String airline_icao;          // operator ICAO, e.g. "AAL"

    /**
     * True only when the feed supplied a ROUTE. Gates skipping the per-flight
     * enrichment lookup, and only a route justifies that -- type and airline
     * arriving inline are consumed regardless.
     *
     * DERIVED, not stored. It was a bool whose own comment said it "is exactly
     * origin||dest", with nothing but that comment holding the two in step: two
     * producers set it by hand, and either could have set it inconsistently with
     * the fields it claims to summarise. Computing it removes the possibility.
     */
    bool hasInlineRoute() const { return origin_iata.length() || dest_iata.length(); }
};
