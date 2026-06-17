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
#include "adapters/FlightWallFetcher.h"

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
                                    const String &icao24, FlightInfo &out)
{
    const unsigned long now = millis();
    const unsigned long ttl = (unsigned long)g_settings.enrichmentCacheSeconds * 1000UL;

    auto it = _cache.find(key);
    if (it != _cache.end() && (now - it->second.ts) < ttl)
    {
        if (!it->second.valid)
            return false; // cached miss; don't re-hammer the provider
        out = it->second.info;
        return true;
    }

    BaseFlightFetcher *f = activeFetcher();
    FlightInfo info;
    bool ok = f ? f->fetchFlightInfo(callsign, icao24, info) : false;

    // Backup: if the free source (adsbdb) missed, fall back to AeroAPI when a key
    // is configured. Also restores Flights-mode metrics (AeroAPI last_position).
    if (!ok &&
        g_settings.enrichmentSource == EnrichmentSource::Adsbdb &&
        g_settings.enrichmentFallbackToAeroApi &&
        g_settings.aeroApiKey.length() > 0 && _aeroApi)
    {
        ok = _aeroApi->fetchFlightInfo(callsign, icao24, info);
    }

    if (ok)
        enrichNames(info);

    if (_cache.size() > 64) // simple bound; aircraft churn over time
        _cache.clear();
    _cache[key] = CacheEntry{info, ok, now};

    if (ok)
        out = info;
    return ok;
}

void FlightDataFetcher::enrichNames(FlightInfo &info)
{
    FlightWallFetcher fw;
    // Airline name: only hit the CDN if we don't already have one. adsbdb's route
    // response already includes it, so this avoids a redundant HTTPS call per flight.
    if (info.operator_icao.length() && info.airline_display_name_full.length() == 0)
    {
        String airlineFull;
        if (fw.getAirlineName(info.operator_icao, airlineFull))
        {
            info.airline_display_name_full = airlineFull;
        }
    }
    // Friendly aircraft short name from the ICAO type (e.g. A21N -> A321neo).
    if (info.aircraft_code.length() && info.aircraft_display_name_short.length() == 0)
    {
        String aircraftShort, aircraftFull;
        if (fw.getAircraftName(info.aircraft_code, aircraftShort, aircraftFull))
        {
            if (aircraftShort.length())
            {
                info.aircraft_display_name_short = aircraftShort;
            }
        }
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
                                       std::vector<FlightInfo> &outFlights)
{
    outStates.clear();
    outFlights.clear();

    if (g_settings.mode == TrackingMode::Flights)
        return fetchFlightsMode(outFlights);
    return fetchAreaMode(outStates, outFlights);
}

size_t FlightDataFetcher::fetchAreaMode(std::vector<StateVector> &outStates,
                                        std::vector<FlightInfo> &outFlights)
{
    bool ok = _stateFetcher->fetchStateVectors(
        g_settings.centerLat,
        g_settings.centerLon,
        g_settings.radiusKm,
        outStates);
    if (!ok)
        return 0;

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
    for (const StateVector &s : candidates)
    {
        if (outFlights.size() >= g_settings.maxFlights)
            break;

        // Cache key prefers the stable ICAO24, falling back to callsign.
        const String key = s.icao24.length() ? s.icao24 : s.callsign;
        FlightInfo info;
        bool ok = getEnriched(key, s.callsign, s.icao24, info);
        if (!ok)
        {
            if (g_settings.enrichmentSource == EnrichmentSource::Off)
                info = FlightInfo(); // show a callsign-only card
            else
                continue; // provider selected but no data for this flight
        }

        if (!passesAirlineAllowList(info))
            continue;

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
    }
    return enriched;
}

size_t FlightDataFetcher::fetchFlightsMode(std::vector<FlightInfo> &outFlights)
{
    size_t enriched = 0;
    for (const String &ident : g_settings.trackedFlights)
    {
        if (outFlights.size() >= g_settings.maxFlights)
            break;
        if (ident.length() == 0)
            continue;

        FlightInfo info;
        bool ok = getEnriched(ident, ident, String(""), info);
        if (!ok)
        {
            if (g_settings.enrichmentSource == EnrichmentSource::Off)
                info = FlightInfo(); // callsign-only card
            else
                continue;
        }

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
