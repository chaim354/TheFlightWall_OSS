/*
Purpose: Approximate the device's location from its public IP (no API key).
Uses ip-api.com's free endpoint over HTTP. Accuracy is city-level and depends on
the ISP — good enough to seed the Area-mode center, but the user should review it.
*/
#pragma once

#include <Arduino.h>

class GeoLocator
{
public:
    // Fills lat/lon and a human-readable place ("City, Region"). Returns false
    // on network/parse failure or an unsuccessful lookup.
    bool locate(double &lat, double &lon, String &place);
};
