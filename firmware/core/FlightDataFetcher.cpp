/*
Purpose: Orchestrate fetching and enrichment of flight data for display.

Supports two tracking modes (driven by g_settings.mode):
- Area:    OpenSky states/all within radius of a center point; metrics come from
           the ADS-B state vector; enriched with AeroAPI route/aircraft + names.
- Flights: A user-specified list of idents/callsigns/tails looked up directly via
           AeroAPI; metrics come from AeroAPI last_position.

Filters (altitude band, on-ground, airline allow-list) and the maxFlights cap are
applied before the (relatively expensive) name enrichment where possible.

Area mode has a second split, orthogonal to the position-source choice above: the
FlightWall server (PositionSource::FlightWallServer) short-circuits the whole
state-vector/enrichment pipeline with fetchServerMode, which fills FlightInfo
directly from one HTTP call. If the server is unreachable that cycle falls back
to the ordinary state-vector path forced onto adsb.lol -- see fetchServerMode.
A server that stays unreachable is backed off (utils/ServerBackoff.h): repeated
failures escalate the retry interval, capped, so a prolonged outage skips the
HTTP call on most cycles instead of paying its timeout every 30s forever.
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
                                     BaseFlightFetcher *adsbdb,
                                     BaseStateVectorFetcher *adsbLolState,
                                     FlightWallServerFetcher *server)
    : _openSkyState(openSkyState), _fr24State(fr24State), _aeroApi(aeroApi), _adsbdb(adsbdb),
      _adsbLolState(adsbLolState), _server(server) {}

BaseStateVectorFetcher *FlightDataFetcher::activeStateFetcher()
{
    switch (g_settings.positionSource)
    {
    case PositionSource::FlightRadar24:
        if (_fr24State) return _fr24State;
        break;
    case PositionSource::AdsbLol:
    case PositionSource::FlightWallServer: // server path runs earlier; this is its fallback
        if (_adsbLolState) return _adsbLolState;
        break;
    default:
        break;
    }
    return _openSkyState;
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

// Single source of truth for is_cargo/is_private plus the hideCargo and airline
// allow-list filters. Shared verbatim by Area mode's consider() (per-candidate,
// via `callsign` = s.callsign) and by applyLocalClassification (the FlightWall
// server path, via `callsign` = info.ident) so the two can never classify the
// same flight differently.
bool FlightDataFetcher::classifyAndFilter(FlightInfo &info, const String &callsign)
{
    // POSITIVE-signal classification. is_private requires BOTH no operator AND a
    // registration-shaped callsign — an airliner always has operator_icao from
    // its prefix, so it can never be is_private (this was the prior bug).
    info.is_cargo = isCargoOperator(info.operator_icao.c_str());
    info.is_private = (info.operator_icao.length() == 0) && isTailNumber(callsign.c_str());

    if (g_settings.filters.hideCargo && info.is_cargo)
        return false; // optional cargo hide

    // General aviation, hidden unless opted in.
    //
    // Area mode expresses the same rule structurally, by only running its
    // GA pass when the setting is on, so this is INERT there: pass 1 never
    // offers a GA callsign and pass 2 never runs while the setting is off.
    // It exists for the FlightWall-server path, which hands back a finished
    // list with no two-pass point to express it at -- that path applied
    // hideCargo and the allow-list but not this, so unchecking the setting
    // did nothing for anyone using a server as their position source.
    //
    // A PINNED flight is exempt. It is on the panel because someone named
    // that exact flight on the watched-flights page, and a private jet is a
    // very ordinary thing to want to follow; dropping it here would answer a
    // direct request with silence and no way to tell why.
    if (!g_settings.filters.showGeneralAviation && !info.pinned &&
        isGeneralAviation(callsign.c_str()))
        return false;

    if (!passesAirlineAllowList(info))
        return false;

    return true;
}

// Vector-wide entry point for a source that hands back a complete FlightInfo list
// with no per-candidate early-return point (the FlightWall server). Implemented
// purely in terms of classifyAndFilter so consider() and this can never drift
// apart into different decisions for the same input.
//
// NOTE: unlike consider(), this cannot set is_helicopter -- that comes from the
// ADS-B emitter category on the raw StateVector (see fetchAreaModeWith), and the
// server's contract carries no equivalent field. It is left at its FlightInfo
// default (false, i.e. "unknown"), so the helicopter badge simply does not show
// for server-sourced rotorcraft rather than risking a wrong positive/negative.
void FlightDataFetcher::applyLocalClassification(std::vector<FlightInfo> &flights)
{
    flights.erase(std::remove_if(flights.begin(), flights.end(),
                                 [this](FlightInfo &info)
                                 { return !classifyAndFilter(info, info.ident); }),
                 flights.end());
}

size_t FlightDataFetcher::fetchFlights(std::vector<FlightInfo> &outFlights, bool &ok)
{
    // Scratch for whichever mode runs; no caller has ever read it.
    std::vector<StateVector> outStates;
    outFlights.clear();
    ok = false;
    _cycleStartMs = millis(); // starts the enrichment budget (see kEnrichBudgetMs)

    // Reset every cycle so a source switch away from FlightWallServer -- or a
    // cycle that falls back to adsb.lol below -- can't leave a previous cycle's
    // stale flag stuck on.
    _lastStale = false;

    if (g_settings.mode == TrackingMode::Area &&
        g_settings.positionSource == PositionSource::FlightWallServer)
        return fetchServerMode(outStates, outFlights, ok);

    if (g_settings.mode == TrackingMode::Flights)
        return fetchFlightsMode(outFlights, ok);
    return fetchAreaMode(outStates, outFlights, ok);
}

size_t FlightDataFetcher::fetchServerMode(std::vector<StateVector> &outStates,
                                          std::vector<FlightInfo> &outFlights, bool &ok)
{
    // Escalating backoff (utils/ServerBackoff.h): once enough consecutive
    // failures have piled up, skip the HTTP call entirely this cycle rather
    // than paying its (now-shortened, but still nonzero) failure cost again.
    // serverBackoffActive() is false whenever _serverConsecutiveFailures is 0,
    // so a server that has never failed -- or that just recovered -- always
    // takes the real attempt below.
    if (!serverBackoffActive())
    {
        // One call, and everything below the wire is already done: joined to the
        // schedule, implausible routes rejected, ETA computed, units converted,
        // sorted nearest-first and capped. No enrichment, no per-flight connection.
        if (_server && _server->fetchFlights(g_settings.serverUrl,
                                             g_settings.centerLat, g_settings.centerLon,
                                             g_settings.radiusKm, g_settings.maxFlights,
                                             outFlights, _lastStale))
        {
            // The server's contract resolves a readable name (`al`) but carries no
            // ICAO operator code, so operator_icao is empty on every flight here.
            // is_cargo and the airline allow-list both key off operator_icao, so
            // without this step they would silently never match anything the server
            // returns. Derive it locally from the callsign first, exactly as every
            // other skip-enrichment path does (see applyLocalIdentity) -- info.ident
            // is already the server's raw `cs` field, the same kind of value
            // s.callsign carries in Area mode.
            for (FlightInfo &info : outFlights)
                applyLocalIdentity(info.ident, info);

            // The server cannot know about the device-side airline allow-list or the
            // cargo/private classification, so those still run here.
            applyLocalClassification(outFlights);

            // A single good response clears the penalty entirely -- no gradual
            // ramp-down. Only worth a log line when it is actually ending a
            // streak; a healthy server succeeding every cycle should stay quiet.
            if (_serverConsecutiveFailures > 0)
                Serial.println("FlightDataFetcher: server recovered; backoff cleared");
            _serverConsecutiveFailures = 0;
            _serverBackoffSkipLogged = false;
            _lastSource = "server";
            _lastSourceFallback = false;
            ok = true;
            return outFlights.size();
        }

        // A real attempt just failed: escalate. New window, so a future skip
        // should log again.
        _serverConsecutiveFailures++;
        _serverLastFailureMs = millis();
        _serverBackoffSkipLogged = false;
        Serial.printf("FlightDataFetcher: server unavailable (%u consecutive failure%s); "
                      "falling back to adsb.lol, next retry in %lus\n",
                      (unsigned)_serverConsecutiveFailures,
                      _serverConsecutiveFailures == 1 ? "" : "s",
                      serverBackoffMs(_serverConsecutiveFailures) / 1000UL);
    }
    else if (!_serverBackoffSkipLogged)
    {
        // First skip of this backoff window -- log it once so the serial log
        // shows why nothing server-related is happening, rather than going
        // quiet in a way that (per an earlier bare-catch bug in this project)
        // is indistinguishable from having stopped working. Every later skip
        // in the same window is expected and silent, not spam.
        Serial.printf("FlightDataFetcher: server backoff active (%u consecutive failures); "
                      "skipping probe, falling back to adsb.lol\n",
                      (unsigned)_serverConsecutiveFailures);
        _serverBackoffSkipLogged = true;
    }

    // Fall back to the keyless direct path for THIS cycle rather than failing:
    // a wall that degrades to callsign-plus-metrics beats one frozen on its
    // last list. The configured source is left unchanged, so a later cycle --
    // immediately if backoff isn't active, or once it lapses -- tries the
    // server again with no user action.
    //
    // Defensive, not a fix for an observed leak: every failure path inside
    // FlightWallServerFetcher::fetchFlights returns before it ever pushes a
    // row, so outFlights is already empty here (and untouched on the pure-skip
    // path). Cheap insurance against that invariant changing later without
    // this call site being revisited.
    outFlights.clear();
    // Set BEFORE the call: fetchAreaModeWith records the source name but cannot
    // know whether reaching it was the plan or a degradation.
    _lastSourceFallback = true;
    return fetchAreaModeWith(_adsbLolState ? _adsbLolState : _openSkyState,
                             outStates, outFlights, ok);
}

size_t FlightDataFetcher::fetchAreaMode(std::vector<StateVector> &outStates,
                                        std::vector<FlightInfo> &outFlights,
                                        bool &ok)
{
    _lastSourceFallback = false;
    return fetchAreaModeWith(activeStateFetcher(), outStates, outFlights, ok);
}

/**
 * Name the state fetcher a pointer refers to, for lastActiveSource().
 *
 * Compares against the members rather than asking the object, because
 * BaseStateVectorFetcher has no name() and giving it one would touch every
 * implementation for a diagnostic string. The pointers are set once in the
 * constructor and never rebound, so identity is a reliable answer.
 */
const char *FlightDataFetcher::sourceNameOf(const BaseStateVectorFetcher *src) const
{
    if (src == nullptr)        return "none";
    if (src == _adsbLolState)  return "adsb.lol";
    if (src == _fr24State)     return "fr24";
    if (src == _openSkyState)  return "opensky";
    return "unknown";
}

size_t FlightDataFetcher::fetchAreaModeWith(BaseStateVectorFetcher *src,
                                            std::vector<StateVector> &outStates,
                                            std::vector<FlightInfo> &outFlights,
                                            bool &ok)
{
    if (!src->fetchStateVectors(
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
    // Recorded HERE, past the failure return above, so the label always names a
    // source that actually answered. Covers both callers: fetchAreaMode with the
    // configured fetcher, and fetchServerMode's fallback with adsb.lol -- which
    // is the case worth seeing, because the settings still say "server".
    _lastSource = sourceNameOf(src);

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
        if (!s.hasInlineRoute())
            getEnriched(s.callsign, s.icao24, info, withinEnrichBudget());

        // Overlay whatever the position source carried inline (e.g. FlightRadar24
        // ships route, type and operator in the same feed). Applied AFTER the
        // lookup on purpose: getEnriched() assigns `info` wholesale on a cache hit,
        // so anything written before the call would be thrown away. None of this is
        // written back into the enrichment cache (_cache in FlightDataFetcher.h) —
        // it's specific to this feed row, not something a different flight sharing
        // that cache key should ever be served.
        //
        // origin/dest: applied whenever the feed has them, with no check for an
        // existing network value first (unlike the airline fill-gap below). Safe
        // only because hasInlineRoute() is exactly origin||dest, which already
        // skipped the lookup above — there is no network value to defer to. If that
        // flag is ever narrowed to origin&&dest, these two guards need re-deriving,
        // or a leg with only one side inline would confidently pair FR24's origin
        // with adsbdb's destination.
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

        // POSITIVE-signal classification plus the hideCargo/allow-list filters —
        // see classifyAndFilter for the shared rule (also used by the FlightWall
        // server path via applyLocalClassification).
        if (!classifyAndFilter(info, s.callsign))
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
        info.is_helicopter = (s.category == 8); // ADS-B rotorcraft category
        info.distance_km = s.distance_km;

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
        if (isGeneralAviation(s.callsign.c_str()))
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
            if (!isGeneralAviation(s.callsign.c_str()))
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
