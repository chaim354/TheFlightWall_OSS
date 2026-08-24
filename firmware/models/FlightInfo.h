#pragma once

#include <Arduino.h>
#include <vector>
#include "AirportInfo.h"

struct FlightInfo
{
    // Flight identifiers
    String ident;
    String ident_icao;

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

    // Live telemetry (populated from OpenSky state vectors in Area mode, or from
    // AeroAPI last_position in Flights mode).
    //
    // ONE encoding of absence, the one utils/ServerJson.h documents and
    // test_serverjson.cpp pins: NAN for numerics, empty String for text. There
    // used to be a `has_metrics` bool alongside it, whose comment claimed it
    // "gates rendering" -- it did not. No render site ever read it; every one
    // gates on NAN. Its sole reader wrapped five guards that each already tested
    // !isnan, and it was set inconsistently besides (AeroAPI set it for
    // altitude/speed/heading but not for vertical rate, while the server path
    // set it unconditionally for every flight including ones where every numeric
    // was NAN). An outer gate that carries no information the inner guards lack.
    double altitude_ft = NAN;       // barometric/geo altitude in feet
    double groundspeed_kt = NAN;    // ground speed in knots
    double heading_deg = NAN;       // track/heading in degrees from north
    double vertical_rate_fpm = NAN; // climb (+) / descent (-) in feet per minute
    bool is_helicopter = false;     // from ADS-B emitter category (rotorcraft)
    bool is_private = false;        // positive signal: no operator + registration-shaped callsign
    bool is_cargo = false;          // operator_icao is a known freight operator
    double distance_km = NAN;       // distance from configured center (Area mode)

    // Time remaining to destination. NAN = unknown, and unknown renders blank.
    //
    // Computed, not scheduled: the server models the last 60nm at a nominal
    // 200kt rather than at the aircraft's current groundspeed, because a naive
    // distance/groundspeed runs optimistic by a near-constant ~10 minutes at
    // any cruise range. It cannot know about vectoring, holds or taxi-in, so it
    // is good to roughly +/-5 min enroute and vaguer near the end.
    double eta_minutes = NAN;
    // Pre-rounded display string from the server: "~25m", "~1h10", or "LANDING"
    // inside 30nm. Rendered VERBATIM -- the rounding is the honesty policy, and
    // re-deriving it on device would let the two drift apart.
    String eta_text;
};
