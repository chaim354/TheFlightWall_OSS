#pragma once
/*
Purpose: Keyless position source backed by adsb.lol, a community ADS-B
aggregator. No account, no API key, no ToS problem — the data is ODbL-licensed
and the API is explicitly open.

Why it exists alongside OpenSky: one call returns position AND ICAO type AND
registration AND a precomputed distance/bearing from the query point, so it
removes the per-flight aircraft lookup from the cycle as well as replacing the
state feed. Aircraft type is keyed by ICAO24 — the airframe — which is why it
was already the one reliable enrichment field; getting it inline costs nothing
in accuracy and one connection less per flight.

What it does NOT carry is a route. Routes still come from the enrichment source,
or from the FlightWall server when that is selected.

Transport discipline mirrors OpenSkyFetcher: its own WiFiClientSecure with a
BOUNDED handshake, so a stalled TLS negotiation fails fast instead of parking
loopTask until the 120s watchdog reboots the wall.
*/

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "interfaces/BaseStateVectorFetcher.h"

class AdsbLolFetcher : public BaseStateVectorFetcher
{
public:
    AdsbLolFetcher() = default;
    ~AdsbLolFetcher() override = default;

    bool fetchStateVectors(double centerLat,
                           double centerLon,
                           double radiusKm,
                           std::vector<StateVector> &outStateVectors) override;

private:
    WiFiClientSecure m_secure;
    bool m_secureInit = false;
    WiFiClientSecure &secureClient();
};
