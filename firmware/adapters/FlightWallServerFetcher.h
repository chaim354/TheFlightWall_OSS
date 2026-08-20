#pragma once
/*
Purpose: Fetch a complete, display-ready flight list from the FlightWall server
in ONE HTTP call.

Why this is NOT a BaseStateVectorFetcher: it does not return state vectors. The
server has already fetched positions, joined them to airport schedules, rejected
implausible routes, computed ETA, converted units, resolved airline names,
filtered, sorted and capped. What comes back is FlightInfo, so this fills the
output list directly and the whole Area-mode enrichment path is skipped.

What that buys: today one cycle can open 1 + 2*maxFlights TLS connections. That
arithmetic is why kEnrichBudgetMs exists, and it is behind a real coredump with
loopTask parked in start_ssl_client(hostname="hexdb.io") until the 120s watchdog
rebooted the wall. One server means one connection, with keep-alive — the
failure mode is removed by construction rather than bounded by a budget.
*/

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <vector>
#include "models/FlightInfo.h"

class FlightWallServerFetcher
{
public:
    FlightWallServerFetcher() = default;

    // Returns false on transport/parse failure OR when the server itself
    // reports ok:false. The caller must treat false as "keep the previous
    // flights", never as "the sky is empty" — an empty SUCCESS blanks the wall.
    //
    // outStale carries the server's own schedule-staleness flag, for the web UI.
    bool fetchFlights(const String &baseUrl,
                      double centerLat,
                      double centerLon,
                      double radiusKm,
                      uint8_t maxFlights,
                      std::vector<FlightInfo> &outFlights,
                      bool &outStale);

private:
    WiFiClientSecure m_secure;
    bool m_secureInit = false;
    WiFiClientSecure &secureClient();
};
