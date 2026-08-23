/*
Purpose: Free flight enrichment via adsbdb.com (+ hexdb.io fallback), no API key.
- /v0/callsign/{cs} -> route (origin/dest ICAO+IATA) and airline name.
- /v0/aircraft/{icao24} -> ICAO aircraft type.
All HTTP goes through the shared streaming HttpJson client. Returns true only
when a NETWORK lookup actually produced route or aircraft data (the caller adds
local callsign-prefix identity separately, so prefix-only is NOT "enriched").
*/
#include "adapters/AdsbdbFetcher.h"
#include "utils/RouteUtils.h"

static const char *kAdsbdbBase = "https://api.adsbdb.com/v0";

static String jstr(JsonObject o, const char *key)
{
    if (o.isNull() || o[key].isNull())
        return String("");
    return o[key].as<String>();
}

bool AdsbdbFetcher::fetchRoute(const String &callsign, FlightInfo &out)
{
    String cs = callsign;
    cs.trim();
    if (cs.length() == 0 || !_http)
        return false;

    JsonDocument doc;
    if (!_http->getJson(String(kAdsbdbBase) + "/callsign/" + cs, doc))
        return false;

    JsonObject fr = doc["response"]["flightroute"].as<JsonObject>();
    if (fr.isNull())
        return false;

    String ident = jstr(fr, "callsign");
    if (ident.length())
        out.ident = ident;
    out.ident_icao = jstr(fr, "callsign_icao");

    JsonObject al = fr["airline"].as<JsonObject>();
    if (!al.isNull())
    {
        if (out.operator_icao.length() == 0)
            out.operator_icao = jstr(al, "icao");
        if (out.operator_iata.length() == 0)
            out.operator_iata = jstr(al, "iata");
        String name = jstr(al, "name");
        if (name.length())
            out.airline_display_name_full = name;
        if (out.operator_code.length() == 0)
            out.operator_code = out.operator_icao;
    }

    JsonObject o = fr["origin"].as<JsonObject>();
    if (!o.isNull())
    {
        out.origin.code_icao = jstr(o, "icao_code");
        out.origin.code_iata = jstr(o, "iata_code");
    }
    JsonObject d = fr["destination"].as<JsonObject>();
    if (!d.isNull())
    {
        out.destination.code_icao = jstr(d, "icao_code");
        out.destination.code_iata = jstr(d, "iata_code");
    }
    return true;
}

bool AdsbdbFetcher::fetchAircraft(const String &icao24, FlightInfo &out)
{
    String hex = icao24;
    hex.trim();
    if (hex.length() == 0 || !_http)
        return false;

    JsonDocument doc;
    if (!_http->getJson(String(kAdsbdbBase) + "/aircraft/" + hex, doc))
        return false;

    JsonObject ac = doc["response"]["aircraft"].as<JsonObject>();
    if (ac.isNull())
        return false;

    String type = jstr(ac, "icao_type");
    if (type.length())
    {
        out.aircraft_code = type;
        return true;
    }
    return false;
}

bool AdsbdbFetcher::fetchRouteHexdb(const String &callsign, FlightInfo &out)
{
    String cs = callsign;
    cs.trim();
    if (cs.length() == 0 || !_http)
        return false;

    JsonDocument doc;
    if (!_http->getJson(String("https://hexdb.io/api/v1/route/icao/") + cs, doc))
        return false;

    String route = doc["route"] | "";
    // hexdb returns a whole rotation ("KLAX-KDFW-KLAX"); take the first leg. Taking
    // first-and-last rendered every round trip as "LAX -> LAX". See RouteUtils.h.
    char originBuf[8], destBuf[8];
    if (!parseFirstLeg(route.c_str(), originBuf, sizeof(originBuf), destBuf, sizeof(destBuf)))
        return false;
    // parseFirstLeg guarantees both segments are non-empty on success, so unlike
    // the old indexOf/substring version there is no "false but one side is set"
    // case left to guard against here.
    if (out.origin.code_icao.length() == 0)
        out.origin.code_icao = originBuf;
    if (out.destination.code_icao.length() == 0)
        out.destination.code_icao = destBuf;
    return true;
}

bool AdsbdbFetcher::fetchAircraftHexdb(const String &icao24, FlightInfo &out)
{
    String hex = icao24;
    hex.trim();
    if (hex.length() == 0 || !_http)
        return false;

    JsonDocument doc;
    if (!_http->getJson(String("https://hexdb.io/api/v1/aircraft/") + hex, doc))
        return false;

    String t = doc["ICAOTypeCode"] | "";
    if (t.length() && out.aircraft_code.length() == 0)
    {
        out.aircraft_code = t;
        return true;
    }
    return false;
}

bool AdsbdbFetcher::fetchFlightInfo(const String &flightIdent, const String &icao24, FlightInfo &outInfo)
{
    bool gotNetworkData = false;

    // Batch by HOST, not by field. The shared HttpJson holds ONE persistent TLS
    // connection, so alternating adsbdb/hexdb (A,B,A,B) forces a full renegotiation
    // on every call. Doing both adsbdb lookups first and only then the hexdb
    // fallbacks (A,A,B,B) keeps keep-alive working, and lets consecutive flights
    // reuse the already-open adsbdb connection.
    bool haveRoute = false;
    bool haveAircraft = false;

    // adsbdb (host A) — route also supplies the airline name.
    if (flightIdent.length() && fetchRoute(flightIdent, outInfo))
    {
        haveRoute = true;
        gotNetworkData = true;
    }
    if (icao24.length() && fetchAircraft(icao24, outInfo))
    {
        haveAircraft = true;
        gotNetworkData = true;
    }

    // hexdb.io (host B) — only for whatever adsbdb missed.
    if (!haveRoute && flightIdent.length() && fetchRouteHexdb(flightIdent, outInfo))
        gotNetworkData = true;
    if (!haveAircraft && icao24.length() && fetchAircraftHexdb(icao24, outInfo))
        gotNetworkData = true;

    // NOTE: callsign-prefix -> operator_icao is applied by the orchestrator
    // (FlightDataFetcher), NOT here, so prefix-only does not count as a network
    // success and never poisons the cache.
    return gotNetworkData;
}
