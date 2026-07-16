/*
Purpose: Orchestrate fetching and enrichment of flight data for display.

Supports two tracking modes (driven by g_settings.mode):
- Area:    OpenSky states/all within radius of a center point; metrics come from
           the ADS-B state vector; enriched with AeroAPI route/aircraft + names.
- Flights: A user-specified list of idents/callsigns/tails looked up directly via
           AeroAPI; metrics come from AeroAPI last_position.

Filters (altitude band, on-ground, airline allow-list) and the maxFlights cap are
applied before the (relatively expensive) name enrichment where possible.
*/
#include "core/FlightDataFetcher.h"
#include "core/Settings.h"
#include "core/Filters.h"
#include "utils/FlightClassify.h"

#include <algorithm>

// OpenSky reports SI units; convert to the aviation units the display uses.
static constexpr double kMetersToFeet = 3.28084;
static constexpr double kMetersPerSecToKnots = 1.94384;
static constexpr double kMetersPerSecToFpm = 196.850;

FlightDataFetcher::FlightDataFetcher(BaseStateVectorFetcher *stateFetcher,
                                     BaseFlightFetcher *aeroApi,
                                     BaseFlightFetcher *adsbdb)
    : _stateFetcher(stateFetcher), _aeroApi(aeroApi), _adsbdb(adsbdb) {}

BaseFlightFetcher *FlightDataFetcher::activeFetcher()
{
    switch (g_settings.enrichmentSource)
    {
    case EnrichmentSource::AeroApi:
        return _aeroApi;
    case EnrichmentSource::Adsbdb:
        return _adsbdb;
    default:
        return nullptr; // Off
    }
}

bool FlightDataFetcher::getEnriched(const String &key, const String &callsign,
                                    const String &icao24, FlightInfo &out,
                                    bool allowNetwork)
{
    const unsigned long now = millis();
    const unsigned long posTtl = (unsigned long)g_settings.enrichmentCacheSeconds * 1000UL;
    const unsigned long negTtl = 60UL * 1000UL; // retry failures after 60s, not the full TTL

    CacheEntry entry;
    if (_cache.get(key, entry))
    {
        CacheAction act = cacheActionFor(true, entry.valid, now - entry.ts, posTtl, negTtl);
        if (act == CacheAction::UseValid)
        {
            out = entry.info;
            return true;
        }
        if (act == CacheAction::SkipNegative)
            return false; // recent failure; don't re-hammer the provider yet
        // else: expired -> fall through and re-fetch
    }

    // Past the cycle's enrichment budget: the cache above still answered if it could,
    // but we will not open a connection. Reported as a miss, which callers already
    // handle as "no route yet" rather than as an error.
    if (!allowNetwork)
        return false;

    BaseFlightFetcher *f = activeFetcher();
    FlightInfo info;
    bool ok = f ? f->fetchFlightInfo(callsign, icao24, info) : false;

    // Backup: if the free source (adsbdb) missed AND a key is set, try AeroAPI.
    if (!ok &&
        g_settings.enrichmentSource == EnrichmentSource::Adsbdb &&
        g_settings.enrichmentFallbackToAeroApi &&
        g_settings.aeroApiKey.length() > 0 && _aeroApi)
    {
        ok = _aeroApi->fetchFlightInfo(callsign, icao24, info);
    }

    // Bounded LRU (capacity intrinsic): inserts evict the least-recently-used
    // entry instead of clearing the whole cache at a size cliff.
    _cache.put(key, CacheEntry{info, ok, now});

    if (ok)
        out = info;
    return ok;
}

// Local, network-free identity from the broadcast callsign: airline ICAO prefix
// -> operator_icao (drives the logo). Always applied so a flight still shows its
// airline/logo even when route/aircraft network lookups fail.
void FlightDataFetcher::applyLocalIdentity(const String &callsign, FlightInfo &info)
{
    char prefix[4];
    if (parseAirlineIcao(callsign.c_str(), prefix) && info.operator_icao.length() == 0)
        info.operator_icao = prefix;
}

bool FlightDataFetcher::passesAirlineAllowList(const FlightInfo &info)
{
    return Filters::airlineAllowed(g_settings.filters.airlineAllowList,
                                   info.operator_icao,
                                   info.operator_iata,
                                   info.operator_code);
}

size_t FlightDataFetcher::fetchFlights(std::vector<StateVector> &outStates,
                                       std::vector<FlightInfo> &outFlights,
                                       bool &ok)
{
    outStates.clear();
    outFlights.clear();
    ok = false;
    _cycleStartMs = millis(); // starts the enrichment budget (see kEnrichBudgetMs)

    if (g_settings.mode == TrackingMode::Flights)
        return fetchFlightsMode(outFlights, ok);
    return fetchAreaMode(outStates, outFlights, ok);
}

size_t FlightDataFetcher::fetchAreaMode(std::vector<StateVector> &outStates,
                                        std::vector<FlightInfo> &outFlights,
                                        bool &ok)
{
    if (!_stateFetcher->fetchStateVectors(
            g_settings.centerLat,
            g_settings.centerLon,
            g_settings.radiusKm,
            outStates))
    {
        // The state fetch itself failed (network/API). Report it so the caller can
        // keep the last known flights instead of treating this as "sky is empty".
        ok = false;
        return 0;
    }

    // The state fetch succeeded. Everything below only ever filters the result, so
    // ending with 0 flights from here is a legitimate "nothing overhead", not a failure.
    ok = true;

    // Pre-filter state vectors by on-ground and altitude band before enrichment.
    std::vector<StateVector> candidates;
    candidates.reserve(outStates.size());
    for (const StateVector &s : outStates)
    {
        if (s.callsign.length() == 0)
            continue;
        if (g_settings.filters.excludeOnGround && s.on_ground)
            continue;
        double altM = !isnan(s.geo_altitude) ? s.geo_altitude : s.baro_altitude;
        double altFt = isnan(altM) ? NAN : altM * kMetersToFeet;
        if (!Filters::altitudeInBand(altFt, g_settings.filters.minAltitudeFt, g_settings.filters.maxAltitudeFt))
            continue;
        candidates.push_back(s);
    }

    // Nearest first, then cap to maxFlights so we don't burn AeroAPI calls.
    std::sort(candidates.begin(), candidates.end(),
              [](const StateVector &a, const StateVector &b)
              { return a.distance_km < b.distance_km; });

    size_t enriched = 0;

    // Enrich + classify + filter a single candidate, pushing it if it survives.
    // Called at most once per candidate (passes are disjoint by parseAirlineIcao).
    auto consider = [&](const StateVector &s)
    {
        if (outFlights.size() >= g_settings.maxFlights)
            return;

        // Cache key prefers the stable ICAO24, falling back to callsign.
        const String key = s.icao24.length() ? s.icao24 : s.callsign;
        FlightInfo info;
        // Best-effort: once the budget is spent this serves cache-only, so the card
        // still renders (callsign + logo below) just without a route.
        getEnriched(key, s.callsign, s.icao24, info, withinEnrichBudget());

        // Local, free identity (logo) is applied whether or not the network lookup
        // succeeded — so airliners always show their logo/airline. In Area mode we
        // always show the candidate flight (callsign + live metrics + logo); route
        // and aircraft type fill in when the network provides them.
        applyLocalIdentity(s.callsign, info);

        // POSITIVE-signal classification. is_private requires BOTH no operator AND a
        // registration-shaped callsign — an airliner always has operator_icao from
        // its prefix, so it can never be is_private (this was the prior bug).
        info.is_cargo = isCargoOperator(info.operator_icao.c_str());
        info.is_private = (info.operator_icao.length() == 0) && isTailNumber(s.callsign.c_str());

        if (g_settings.filters.hideCargo && info.is_cargo)
            return; // optional cargo hide

        if (!passesAirlineAllowList(info))
            return;

        // Metrics from the live ADS-B state vector.
        double altM = !isnan(s.geo_altitude) ? s.geo_altitude : s.baro_altitude;
        if (!isnan(altM))
            info.altitude_ft = altM * kMetersToFeet;
        if (!isnan(s.velocity))
            info.groundspeed_kt = s.velocity * kMetersPerSecToKnots;
        if (!isnan(s.heading))
            info.heading_deg = s.heading;
        if (!isnan(s.vertical_rate))
            info.vertical_rate_fpm = s.vertical_rate * kMetersPerSecToFpm;
        info.on_ground = s.on_ground;
        info.is_helicopter = (s.category == 8); // ADS-B rotorcraft category
        info.distance_km = s.distance_km;
        info.bearing_deg = s.bearing_deg;
        info.has_metrics = true;

        // Fall back to the live callsign as ident if AeroAPI gave us nothing.
        if (info.ident.length() == 0)
            info.ident = s.callsign;

        outFlights.push_back(info);
        enriched++;
    };

    // PASS 1 — airliners (airline-format callsign). Always shown; they win the slots.
    for (const StateVector &s : candidates)
    {
        if (outFlights.size() >= g_settings.maxFlights)
            break;
        char p[4];
        if (!parseAirlineIcao(s.callsign.c_str(), p))
            continue; // non-airline -> pass 2
        consider(s);
    }

    // PASS 2 — GA / private (non-airline-format), ONLY if opted in. Last priority,
    // leftover slots only. Never enriched when disabled (split decided locally).
    if (g_settings.filters.showGeneralAviation)
    {
        for (const StateVector &s : candidates)
        {
            if (outFlights.size() >= g_settings.maxFlights)
                break;
            char p[4];
            if (parseAirlineIcao(s.callsign.c_str(), p))
                continue; // already handled in pass 1
            consider(s);
        }
    }
    return enriched;
}

size_t FlightDataFetcher::fetchFlightsMode(std::vector<FlightInfo> &outFlights, bool &ok)
{
    // A per-flight enrichment miss is a partial result, not a total failure: the
    // tracked list is user-curated and an ident simply may not be airborne now.
    ok = true;
    size_t enriched = 0;
    for (const String &ident : g_settings.trackedFlights)
    {
        if (outFlights.size() >= g_settings.maxFlights)
            break;
        if (ident.length() == 0)
            continue;

        FlightInfo info;
        // Unlike Area mode, a miss here drops the card (see below), so an exhausted
        // budget means this ident simply waits for the next cycle.
        bool ok = getEnriched(ident, ident, String(""), info, withinEnrichBudget());
        if (!ok)
        {
            if (g_settings.enrichmentSource == EnrichmentSource::Off)
                info = FlightInfo(); // callsign-only card
            else
                continue;
        }

        applyLocalIdentity(ident, info);

        // Positive-signal classification (same rule as Area mode) for consistent
        // display tagging. This is a user-curated list, so no two-pass / hide here.
        info.is_cargo = isCargoOperator(info.operator_icao.c_str());
        info.is_private = (info.operator_icao.length() == 0) && isTailNumber(ident.c_str());

        if (!passesAirlineAllowList(info))
            continue;

        // Altitude-band filter (on_ground is rarely reported here; honor it best-effort).
        if (!Filters::altitudeInBand(info.altitude_ft, g_settings.filters.minAltitudeFt, g_settings.filters.maxAltitudeFt))
            continue;

        if (info.ident.length() == 0)
            info.ident = ident;

        outFlights.push_back(info);
        enriched++;
    }
    return enriched;
}
