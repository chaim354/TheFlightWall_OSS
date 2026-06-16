#pragma once

#include <Arduino.h>
#include <vector>
#include "AirportInfo.h"

struct FlightInfo
{
    // Flight identifiers
    String ident;
    String ident_icao;
    String ident_iata;

    // Operator
    String operator_code;
    String operator_icao;
    String operator_iata;

    // Route
    AirportInfo origin;
    AirportInfo destination;

    // Aircraft
    String aircraft_code;

    // Human-friendly display strings
    String airline_display_name_full;
    String aircraft_display_name_short;

    // Live telemetry (populated from OpenSky state vectors in Area mode, or from
    // AeroAPI last_position in Flights mode). has_metrics gates rendering.
    bool has_metrics = false;
    double altitude_ft = NAN;       // barometric/geo altitude in feet
    double groundspeed_kt = NAN;    // ground speed in knots
    double heading_deg = NAN;       // track/heading in degrees from north
    double vertical_rate_fpm = NAN; // climb (+) / descent (-) in feet per minute
    bool on_ground = false;
    double distance_km = NAN;       // distance from configured center (Area mode)
    double bearing_deg = NAN;       // bearing from configured center (Area mode)
};
