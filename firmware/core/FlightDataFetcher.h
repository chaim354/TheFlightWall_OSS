#pragma once

#include <Arduino.h>
#include <vector>
#include "interfaces/BaseStateVectorFetcher.h"
#include "interfaces/BaseFlightFetcher.h"
#include "adapters/FlightWallServerFetcher.h"
#include "models/StateVector.h"
#include "models/FlightInfo.h"
#include "utils/CallsignUtils.h"
#include "utils/LruCache.h"
#include "utils/ServerBackoff.h"

class FlightDataFetcher
{
public:
    FlightDataFetcher(BaseStateVectorFetcher *openSkyState,
                      BaseStateVectorFetcher *fr24State,
                      BaseFlightFetcher *aeroApi,
                      BaseFlightFetcher *adsbdb,
                      BaseStateVectorFetcher *adsbLolState,
                      FlightWallServerFetcher *server);

    // Fetches according to the current tracking mode in g_settings, applies
    // filters, caps to maxFlights, and enriches with friendly names + metrics.
    // `ok` distinguishes a genuine "0 flights overhead" (ok=true, returns 0) from
    // a failed fetch (ok=false) — callers must not blank the display on failure.
    //
    // The StateVector buffer the modes fill is scratch and stays inside: it used
    // to be a leading out-parameter that every caller had to declare and none
    // ever read. It remains a local inside fetchFlights (not a member), so the
    // allocation pattern is exactly what it was -- this narrows the interface,
    // it does not retain heap between cycles.
    size_t fetchFlights(std::vector<FlightInfo> &outFlights, bool &ok);

    // Whether the last fetch's schedule data was flagged stale by the server.
    // Surfaced in the web UI only — a stale schedule still renders normally.
    bool lastFetchStale() const { return _lastStale; }

    /**
     * The source that ACTUALLY produced the last flights -- not the configured
     * one.
     *
     * Those diverge routinely and silently. In server mode a failed call falls
     * back to adsb.lol for that cycle while `positionSource` still reads
     * "server", so the settings document and the web UI both keep claiming a
     * source the device is not using. On 2026-08-28 a board spent hours
     * alternating between the two and the only way to see it was a USB cable
     * and the serial log.
     *
     * A literal, never freed and never null: every value is a string constant.
     */
    const char *lastActiveSource() const { return _lastSource; }

    /** True when the last fetch used a FALLBACK rather than the configured
     *  source -- i.e. server mode degraded to adsb.lol for that cycle. */
    bool lastSourceWasFallback() const { return _lastSourceFallback; }

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

    BaseStateVectorFetcher *_openSkyState;
    BaseStateVectorFetcher *_fr24State;
    BaseFlightFetcher *_aeroApi;
    BaseFlightFetcher *_adsbdb;
    // Keyless fallback source. Doubles as the server path's OWN fallback when the
    // FlightWall server is unreachable (see fetchServerMode) — that reuse is why
    // it is looked up directly rather than only through activeStateFetcher().
    BaseStateVectorFetcher *_adsbLolState;
    FlightWallServerFetcher *_server;

    // Start of the current fetch cycle, for kEnrichBudgetMs. Set in fetchFlights().
    unsigned long _cycleStartMs = 0;

    // Reset to false at the top of every fetchFlights() call and only ever set true
    // by a successful, stale-flagged server response — so switching away from
    // FlightWallServer can't leave a previous cycle's stale flag stuck on.
    bool _lastStale = false;
    // "none" until a fetch succeeds, so the UI can say "unknown" rather than
    // assert a source the device has not actually used yet.
    const char *_lastSource = "none";
    bool _lastSourceFallback = false;

    // Unsigned subtraction, deliberately: it stays correct across the ~49.7-day millis()
    // wrap, where a naive `millis() >= deadline` would not.
    bool withinEnrichBudget() const
    {
        return (millis() - _cycleStartMs) < kEnrichBudgetMs;
    }

    // Escalating backoff state for the FlightWall-server call, kept HERE rather
    // than in FlightWallServerFetcher because this is where the fallback
    // decision already lives (fetchServerMode) -- see utils/ServerBackoff.h for
    // the schedule and reasoning. _serverConsecutiveFailures resets to 0 on any
    // successful server response; _serverLastFailureMs is the millis() of the
    // failure that (re)armed the current backoff window.
    uint32_t _serverConsecutiveFailures = 0;
    unsigned long _serverLastFailureMs = 0;
    // Set once a "backoff is skipping the server" line has been logged for the
    // CURRENT window, so a long outage logs that transition once rather than on
    // every skipped cycle. Cleared whenever the window is (re)armed by a new
    // failure or cleared by a success, so the next window logs again.
    bool _serverBackoffSkipLogged = false;

    // Same wrap-safe idiom as withinEnrichBudget() just above: unsigned
    // subtraction against millis() stays correct across the ~49.7-day wrap,
    // where comparing a stored absolute "retry at" deadline with
    // `millis() >= retryAt` would not. The actual schedule/decision is the
    // pure, host-tested shouldSkipServer() in utils/ServerBackoff.h; this
    // method only supplies the one wrap-sensitive input it needs.
    bool serverBackoffActive() const
    {
        return shouldSkipServer(_serverConsecutiveFailures, millis() - _serverLastFailureMs);
    }

    // Per-leg enrichment cache (keyed by callsign, ICAO24 only as a defensive
    // fallback — see enrichmentCacheKey()). Static flight data (route/airline/
    // aircraft) rarely changes during a pass, so caching it avoids re-querying
    // the provider every fetch cycle.
    //
    // The cached FlightInfo also carries airframe-scoped fields (aircraft_code,
    // fetched by ICAO24 — see AdsbdbFetcher::fetchFlightInfo) alongside the
    // leg-scoped route/airline, riding along on the leg key. Accepted trade-off:
    // two airframes sharing a generic callsign within one TTL can cross-serve
    // aircraft type, and the airframe half re-fetches on every callsign change —
    // both preferable to serving a wrong route.
    struct CacheEntry
    {
        FlightInfo info;
        bool valid;
        unsigned long ts;
    };
    LruCache<String, CacheEntry> _cache{64};

    BaseFlightFetcher *activeFetcher();
    // Position source per g_settings.positionSource (mirrors activeFetcher()).
    BaseStateVectorFetcher *activeStateFetcher();
    /** Which of the state fetchers a pointer is, by identity. See the .cpp. */
    const char *sourceNameOf(const BaseStateVectorFetcher *src) const;
    // Cache key is derived internally from (callsign, icao24) via enrichmentCacheKey()
    // — the single canonical policy shared by both tracking modes; callers pass their
    // identity fields and do not compute a key themselves.
    //
    // allowNetwork=false serves the cache only and never opens a connection — how the
    // enrichment budget is enforced. The cache is still consulted because a hit is free
    // and costs no time we are trying to protect.
    bool getEnriched(const String &callsign, const String &icao24,
                     FlightInfo &out, bool allowNetwork);

    size_t fetchAreaMode(std::vector<StateVector> &outStates,
                         std::vector<FlightInfo> &outFlights,
                         bool &ok);
    // Pure extraction of fetchAreaMode's former body: identical behaviour, source
    // now a parameter instead of an internal activeStateFetcher() call. The only
    // reason this exists is so fetchServerMode's fallback can force adsb.lol for
    // one cycle without mutating g_settings.positionSource. fetchAreaMode itself
    // is now just `return fetchAreaModeWith(activeStateFetcher(), ...);`.
    size_t fetchAreaModeWith(BaseStateVectorFetcher *src,
                             std::vector<StateVector> &outStates,
                             std::vector<FlightInfo> &outFlights,
                             bool &ok);
    size_t fetchFlightsMode(std::vector<FlightInfo> &outFlights, bool &ok);
    // One HTTP call to the FlightWall server; fills outFlights directly and skips
    // Area-mode enrichment entirely. outStates is unused on the happy path but is
    // threaded through because the failure path falls back into fetchAreaModeWith,
    // which needs somewhere to put adsb.lol's state vectors.
    size_t fetchServerMode(std::vector<StateVector> &outStates,
                           std::vector<FlightInfo> &outFlights,
                           bool &ok);

    void applyLocalIdentity(const String &callsign, FlightInfo &info);
    bool passesAirlineAllowList(const FlightInfo &info);

    // Single source of truth for is_cargo/is_private plus the hideCargo and
    // airline-allow-list filters — the POSITIVE-signal design documented at its
    // definition. `callsign` is the raw broadcast-style identifier tested for
    // registration shape: s.callsign in Area mode, or the server's `cs` field
    // (already living in info.ident by the time this runs) for the server path.
    // Returns false when the flight should be dropped.
    bool classifyAndFilter(FlightInfo &info, const String &callsign);

    // Vector-wide entry point for a source that hands back a complete FlightInfo
    // list with no per-candidate early-return point (the FlightWall server).
    // Implemented purely in terms of classifyAndFilter so consider() (Area mode)
    // and this (server mode) can never drift apart into different decisions for
    // the same input.
    void applyLocalClassification(std::vector<FlightInfo> &flights);
};
