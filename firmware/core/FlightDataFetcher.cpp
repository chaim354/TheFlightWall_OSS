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
#include "utils/AirlineNames.h"
#include "core/Settings.h"
#include "core/Filters.h"
#include "utils/FlightClassify.h"

#include <algorithm>

// OpenSky reports SI units; convert to the aviation units the display uses.
static constexpr double kMetersToFeet = 3.28084;
static constexpr double kMetersPerSecToKnots = 1.94384;
static constexpr double kMetersPerSecToFpm = 196.850;

FlightDataFetcher::FlightDataFetcher(BaseStateVectorFetcher *openSkyState,
                                     BaseStateVectorFetcher *fr24State,
                                     BaseFlightFetcher *aeroApi,
                                     BaseFlightFetcher *adsbdb)
    : _openSkyState(openSkyState), _fr24State(fr24State), _aeroApi(aeroApi), _adsbdb(adsbdb) {}

BaseStateVectorFetcher *FlightDataFetcher::activeStateFetcher()
{
    return (g_settings.positionSource == PositionSource::FlightRadar24 && _fr24State)
               ? _fr24State
               : _openSkyState;
}

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

bool FlightDataFetcher::getEnriched(const String &callsign, const String &icao24,
                                    FlightInfo &out, bool allowNetwork)
{
    // Single canonical cache-key policy for both tracking modes (Area, Flights) —
    // see enrichmentCacheKey() for the callsign-over-ICAO24 rationale.
    const String key = enrichmentCacheKey(callsign.c_str(), icao24.c_str());

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

    // Resolve the operator's display name on device. Guarded on the field being empty so
    // adsbdb stays authoritative under OpenSky — this fills the gap, it does not
    // override enrichment. Under Flightradar24 nothing else ever sets it, which is why
    // the panel and the web list both rendered "DAL" rather than "Delta". An unlisted
    // code leaves the field empty and both surfaces fall back to showing the code, which
    // is the pre-existing behaviour rather than a regression.
    if (info.airline_display_name_full.length() == 0 && info.operator_icao.length())
    {
        const char *name = airlineNameForIcao(info.operator_icao.c_str());
        if (name)
            info.airline_display_name_full = name;
    }
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
    if (!activeStateFetcher()->fetchStateVectors(
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

        FlightInfo info;
        // Skip the per-flight network lookup ONLY when the feed carried the route;
        // that is the expensive thing we are avoiding. Best-effort: once the budget
        // is spent this serves cache-only, so the card still renders (callsign +
        // logo below) just without a route.
        //
        // Under OpenSky this is simply the normal path — the flag is never set
        // there. Under FR24 it is the GA/private and unscheduled case: FR24 has no
        // schedule for them either, and the lookup usually misses too (adsbdb/hexdb
        // key routes on airline-format callsigns, never a tail number). Bounded by
        // maxFlights and the 45s budget, so the cost is wasted round trips, not
        // watchdog headroom.
        if (!s.has_inline_enrichment)
            getEnriched(s.callsign, s.icao24, info, withinEnrichBudget());

        // Overlay whatever the position source carried inline (e.g. FlightRadar24
        // ships route, type and operator in the same feed). Applied AFTER the
        // lookup on purpose: getEnriched() assigns `info` wholesale on a cache hit,
        // so anything written before the call would be thrown away. None of this is
        // written back into the enrichment cache (_cache in FlightDataFetcher.h) —
        // it's specific to this feed row, not something a different flight sharing
        // that cache key should ever be served.
        //
        // origin/dest: unconditional. Safe only because has_inline_enrichment is
        // exactly origin||dest, which already skipped the lookup above — there is
        // no network value to defer to. If that flag is ever narrowed to
        // origin&&dest, these two guards need re-deriving, or a leg with only one
        // side inline would confidently pair FR24's origin with adsbdb's destination.
        if (s.origin_iata.length())
            info.origin.code_iata = s.origin_iata;
        if (s.dest_iata.length())
            info.destination.code_iata = s.dest_iata;

        // aircraft_type: unconditional, and deliberately overwrites whatever the
        // lookup just set — this isn't just "runs after" it. The enrichment cache
        // (_cache in FlightDataFetcher.h) is keyed by callsign, and its comment
        // documents that two airframes sharing a generic callsign within one TTL
        // can cross-serve aircraft_code. FR24's type is per-feed-row — scoped to
        // this exact icao24, this cycle — so this overlay actively corrects that
        // documented hazard rather than leaving it to chance.
        if (s.aircraft_type.length())
            info.aircraft_code = s.aircraft_type;

        // airline: fill-gap, NOT overwrite — unlike origin/dest/aircraft_type
        // above. Only step in when operator_icao specifically is empty:
        // AdsbdbFetcher::fetchRoute and AeroAPIFetcher::fetchFlightInfo can each
        // leave operator_icao empty while operator_iata/operator_code/
        // airline_display_name_full are already set from a partial match (an
        // airline object with a name but no icao; an AeroAPI response with iata
        // but no icao). Clear those three when we overlay operator_icao so
        // applyLocalIdentity below re-derives the display name from THIS icao,
        // instead of leaving a leftover value from whatever the lookup partially
        // matched — an uncleared operator_iata in particular would still leak
        // into Hub75Display's text fallback and into Filters::airlineAllowed's
        // OR-match. That is what makes the group unconditionally consistent, not
        // just in the common case.
        if (s.airline_icao.length() && info.operator_icao.length() == 0)
        {
            info.operator_icao = s.airline_icao;
            info.operator_iata = "";
            info.operator_code = "";
            info.airline_display_name_full = "";
        }

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
        bool ok = getEnriched(ident, String(""), info, withinEnrichBudget());
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
