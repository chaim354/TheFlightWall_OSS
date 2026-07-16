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
    // `ok` distinguishes a genuine "0 flights overhead" (ok=true, returns 0) from
    // a failed fetch (ok=false) — callers must not blank the display on failure.
    size_t fetchFlights(std::vector<StateVector> &outStates,
                        std::vector<FlightInfo> &outFlights,
                        bool &ok);

private:
    // Wall-clock a single fetch cycle may spend on NETWORK enrichment before it stops
    // opening new connections and renders what it already has.
    //
    // Load-bearing against the 120s loop watchdog, not a tuning nicety. One cycle can
    // make 1 + 2*maxFlights connections (OpenSky, then adsbdb + hexdb per flight). On a
    // degraded link each costs a 5s connect timeout plus up to a 15s handshake, so at
    // maxFlights=8 the worst case is ~320s of blocking inside ONE loop() iteration. The
    // watchdog fires at 120s and the wall reboots. That is arithmetic, not bad luck, and
    // it was captured exactly that way in a coredump: loopTask parked in
    // sys_arch_sem_wait <- lwip_select <- start_ssl_client(hostname="hexdb.io").
    //
    // 45s leaves room for OpenSky's own worst case (~20s) inside the same 120s budget.
    // Overrunning is NOT a failure: enrichment is best-effort by design, so an
    // un-enriched flight still renders with its callsign and airline logo
    // (applyLocalIdentity is local and free) and picks up its route on a later cycle
    // once the cache fills.
    static const unsigned long kEnrichBudgetMs = 45000;

    BaseStateVectorFetcher *_stateFetcher;
    BaseFlightFetcher *_aeroApi;
    BaseFlightFetcher *_adsbdb;

    // Start of the current fetch cycle, for kEnrichBudgetMs. Set in fetchFlights().
    unsigned long _cycleStartMs = 0;

    // Unsigned subtraction, deliberately: it stays correct across the ~49.7-day millis()
    // wrap, where a naive `millis() >= deadline` would not.
    bool withinEnrichBudget() const
    {
        return (millis() - _cycleStartMs) < kEnrichBudgetMs;
    }

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
    // allowNetwork=false serves the cache only and never opens a connection — how the
    // enrichment budget is enforced. The cache is still consulted because a hit is free
    // and costs no time we are trying to protect.
    bool getEnriched(const String &key, const String &callsign,
                     const String &icao24, FlightInfo &out, bool allowNetwork);

    size_t fetchAreaMode(std::vector<StateVector> &outStates,
                         std::vector<FlightInfo> &outFlights,
                         bool &ok);
    size_t fetchFlightsMode(std::vector<FlightInfo> &outFlights, bool &ok);

    void applyLocalIdentity(const String &callsign, FlightInfo &info);
    bool passesAirlineAllowList(const FlightInfo &info);
};
