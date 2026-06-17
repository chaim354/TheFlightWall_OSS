#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "interfaces/BaseFlightFetcher.h"

// Free flight enrichment via adsbdb.com (no API key required).
//  - callsign  -> route (origin/destination ICAO) + airline (name/icao/iata)
//  - ICAO24    -> aircraft ICAO type + registered owner (operator) fallback
// A drop-in, no-cost alternative to AeroAPI for route/airline/aircraft lookup.
class AdsbdbFetcher : public BaseFlightFetcher
{
public:
    bool fetchFlightInfo(const String &flightIdent, const String &icao24, FlightInfo &outInfo) override;

private:
    bool httpGetJson(const String &url, String &outPayload);
    bool fetchRoute(const String &callsign, FlightInfo &out);        // adsbdb route
    bool fetchAircraft(const String &icao24, FlightInfo &out);       // adsbdb aircraft type
    bool fetchRouteHexdb(const String &callsign, FlightInfo &out);   // hexdb.io route fallback
    bool fetchAircraftHexdb(const String &icao24, FlightInfo &out);  // hexdb.io aircraft fallback
};
