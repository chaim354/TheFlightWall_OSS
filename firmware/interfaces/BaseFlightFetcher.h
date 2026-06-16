#pragma once

#include <Arduino.h>
#include "models/FlightInfo.h"

class BaseFlightFetcher
{
public:
    virtual ~BaseFlightFetcher() = default;
    // ident = callsign/flight number (for route + airline lookup).
    // icao24 = Mode-S hex (for aircraft-type lookup); may be empty (Flights mode).
    virtual bool fetchFlightInfo(const String &flightIdent, const String &icao24, FlightInfo &outInfo) = 0;
};
