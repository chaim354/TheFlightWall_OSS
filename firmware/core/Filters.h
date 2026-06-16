/*
Purpose: Pure, side-effect-free predicates for aircraft filtering.

Kept free of network/display/settings dependencies so they can be unit tested
directly (see firmware/test/) and reused by FlightDataFetcher.
*/
#pragma once

#include <Arduino.h>
#include <math.h>
#include <vector>

namespace Filters
{
    // An unknown altitude (NaN) is treated as passing the band.
    inline bool altitudeInBand(double altFt, double minFt, double maxFt)
    {
        if (isnan(altFt))
            return true;
        return altFt >= minFt && altFt <= maxFt;
    }

    // Empty allow-list means "allow everything". Otherwise any of the operator
    // codes matching (case-insensitive) lets the flight through.
    inline bool airlineAllowed(const std::vector<String> &allowList,
                               const String &operatorIcao,
                               const String &operatorIata,
                               const String &operatorCode)
    {
        if (allowList.empty())
            return true;
        for (const String &c : allowList)
        {
            if (c.equalsIgnoreCase(operatorIcao) ||
                c.equalsIgnoreCase(operatorIata) ||
                c.equalsIgnoreCase(operatorCode))
                return true;
        }
        return false;
    }
}
