/*
Purpose: Free flight enrichment via adsbdb.com (no API key).
- GET /v0/callsign/{callsign} -> flightroute: airline + origin/destination ICAO.
- GET /v0/aircraft/{icao24}   -> aircraft: icao_type + registered owner codes.
Maps results into FlightInfo (route/operator/aircraft + friendly airline name).
*/
#include "adapters/AdsbdbFetcher.h"

static const char *kAdsbdbBase = "https://api.adsbdb.com/v0";

static String jstr(JsonObject o, const char *key)
{
    if (o.isNull() || o[key].isNull())
        return String("");
    return o[key].as<String>();
}

bool AdsbdbFetcher::httpGetJson(const String &url, String &outPayload)
{
    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    http.begin(client, url);
    http.addHeader("Accept", "application/json");
    http.setTimeout(12000);

    int code = http.GET();
    if (code != 200)
    {
        http.end();
        return false; // 404 = unknown callsign/aircraft (not an error worth logging loudly)
    }
    outPayload = http.getString();
    http.end();
    return true;
}

bool AdsbdbFetcher::fetchRoute(const String &callsign, FlightInfo &out)
{
    String cs = callsign;
    cs.trim();
    if (cs.length() == 0)
        return false;

    String payload;
    if (!httpGetJson(String(kAdsbdbBase) + "/callsign/" + cs, payload))
        return false;

    DynamicJsonDocument doc(4096);
    if (deserializeJson(doc, payload))
        return false;

    JsonObject fr = doc["response"]["flightroute"].as<JsonObject>();
    if (fr.isNull())
        return false;

    String ident = jstr(fr, "callsign");
    if (ident.length())
        out.ident = ident;
    out.ident_icao = jstr(fr, "callsign_icao");
    out.ident_iata = jstr(fr, "callsign_iata");

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
    if (hex.length() == 0)
        return false;

    String payload;
    if (!httpGetJson(String(kAdsbdbBase) + "/aircraft/" + hex, payload))
        return false;

    DynamicJsonDocument doc(4096);
    if (deserializeJson(doc, payload))
        return false;

    JsonObject ac = doc["response"]["aircraft"].as<JsonObject>();
    if (ac.isNull())
        return false;

    // Only the aircraft ICAO type is reliable/useful here. The "registered_owner"
    // is frequently a leasing company, not the operating airline, so we take the
    // airline strictly from the callsign route lookup instead.
    String type = jstr(ac, "icao_type");
    if (type.length())
    {
        out.aircraft_code = type;
        return true;
    }
    return false;
}

bool AdsbdbFetcher::fetchFlightInfo(const String &flightIdent, const String &icao24, FlightInfo &outInfo)
{
    bool ok = false;
    if (flightIdent.length())
        ok = fetchRoute(flightIdent, outInfo) || ok;
    if (icao24.length())
        ok = fetchAircraft(icao24, outInfo) || ok;
    return ok;
}
