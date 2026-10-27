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
    // Server-pinned tracked flight: always shown, ahead of overhead traffic.
    bool pinned = false;
    // Position is a schedule projection, not an observed fix. Rendered
    // differently so the panel never asserts a position nobody measured.
    bool position_estimated = false;
    double distance_km = NAN;       // distance from configured center (Area mode)

    // Time remaining to destination. NAN = unknown, and unknown renders blank.
    //
    // Computed, not scheduled: the server models the last 60nm at a nominal
    // 200kt rather than at the aircraft's current groundspeed, because a naive
    // distance/groundspeed runs optimistic by a near-constant ~10 minutes at
    // any cruise range. It cannot know about vectoring, holds or taxi-in, so it
    // is good to roughly +/-5 min enroute and vaguer near the end.
    double eta_minutes = NAN;
    // Pre-rounded display string from the server: "25m", "1h10m", or "LANDING"
    // inside 30nm. Rendered VERBATIM -- the rounding is the honesty policy, and
    // re-deriving it on device would let the two drift apart.
    String eta_text;

    // How far through the journey, 0-100. NAN = unknown, and unknown draws no
    // bar at all rather than an empty one.
    //
    // TRACKED CARDS ONLY, and NAN on every other flight by construction -- the
    // server sends `prog` only on a pinned card, because only a tracked entry
    // has a departure time to measure from (see src/tracked/serve.ts). An
    // aircraft that merely passed overhead has an arrival estimate and no
    // start, so there is no fraction to draw and no bar is drawn.
    //
    // Scheduled, not observed: it is elapsed fraction of the published block,
    // the same clock eta_text is rounded from. The two are deliberately the
    // same source so the bar and the words can never contradict each other,
    // which is also why the panel renders them in the same colour.
    double progress_pct = NAN;

    // The rest of a tracked card's three views (see Hub75Display's
    // TrackedView). Server-composed like eta_text, and absent -- NAN / empty --
    // on every area card and on a server that predates them, in which case the
    // card simply has fewer views.
    //
    // Statute miles from the origin airport to the current position, great
    // circle. Shown where the flight number would be. POSITIONAL, unlike
    // progress_pct, so a late departure makes the two disagree: the bar runs
    // ahead on the timetable while this reads where the aircraft really is.
    double flown_mi = NAN;
    // The Times view's two spans, pre-formatted in words: "20 min", "3.5 hr".
    // dep_text is since SCHEDULED departure; arr_text is to the scheduled
    // arrival -- eta_text's clock in the same words, or "LANDING" exactly when
    // eta_text says so. Empty arr_text (an older server) falls back to
    // eta_text; see Hub75Display's arrivalText.
    String dep_text;
    String arr_text;
    // The town under the aircraft, its state/province or country, and whether
    // it is merely NEAR rather than under (the server decides the threshold).
    String over_place;
    String over_region;
    bool over_near = false;
};
