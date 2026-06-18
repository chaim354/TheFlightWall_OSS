#pragma once

#include <Arduino.h>
#include <vector>
#include "interfaces/BaseStateVectorFetcher.h"
#include "interfaces/BaseFlightFetcher.h"
#include "models/StateVector.h"
#include "models/FlightInfo.h"
#include "utils/CallsignUtils.h"
#include "utils/LruCache.h"

class FlightDataFetcher
{
public:
    FlightDataFetcher(BaseStateVectorFetcher *stateFetcher,
                      BaseFlightFetcher *aeroApi,
                      BaseFlightFetcher *adsbdb);

    // Fetches according to the current tracking mode in g_settings, applies
    // filters, caps to maxFlights, and enriches with friendly names + metrics.
    size_t fetchFlights(std::vector<StateVector> &outStates,
                        std::vector<FlightInfo> &outFlights);

private:
    BaseStateVectorFetcher *_stateFetcher;
    BaseFlightFetcher *_aeroApi;
    BaseFlightFetcher *_adsbdb;

    // Per-aircraft enrichment cache (keyed by ICAO24 or callsign). Static flight
    // data (route/airline/aircraft) rarely changes during a pass, so caching it
    // avoids re-querying the provider every fetch cycle.
    struct CacheEntry
    {
        FlightInfo info;
        bool valid;
        unsigned long ts;
    };
    LruCache<String, CacheEntry> _cache{64};

    BaseFlightFetcher *activeFetcher();
    bool getEnriched(const String &key, const String &callsign,
                     const String &icao24, FlightInfo &out);

    size_t fetchAreaMode(std::vector<StateVector> &outStates,
                         std::vector<FlightInfo> &outFlights);
    size_t fetchFlightsMode(std::vector<FlightInfo> &outFlights);

    void applyLocalIdentity(const String &callsign, FlightInfo &info);
    bool passesAirlineAllowList(const FlightInfo &info);
};
