/*
Purpose: Retrieve detailed flight metadata from AeroAPI over HTTPS.
Responsibilities:
- Perform authenticated GET to /flights/{ident} using API key.
- Parse minimal fields into FlightInfo (ident/operator/aircraft and ICAO codes).
- Handle TLS (optionally insecure for dev) and JSON errors gracefully.
Input: flight ident (e.g., callsign).
Output: Populates FlightInfo on success and returns true.
*/
#include "adapters/AeroAPIFetcher.h"
#include "core/Settings.h"

static String safeGetString(JsonVariant v, const char *key)
{
    if (!v.containsKey(key) || v[key].isNull())
        return String("");
    return String(v[key].as<const char *>());
}

bool AeroAPIFetcher::fetchFlightInfo(const String &flightIdent, const String &icao24, FlightInfo &outInfo)
{
    (void)icao24; // AeroAPI looks up by ident; icao24 unused

    String url = String(APIConfiguration::AEROAPI_BASE_URL) + "/flights/" + flightIdent;

    JsonDocument doc;
    if (!_http || g_settings.aeroApiKey.length() == 0)
        return false;
    if (!_http->getJson(url, doc, nullptr, nullptr, "x-apikey", g_settings.aeroApiKey.c_str()))
        return false;

    JsonArray flights = doc["flights"].as<JsonArray>();
    if (flights.isNull() || flights.size() == 0)
    {
        Serial.printf("AeroAPIFetcher: No flights found in response for %s\n", flightIdent.c_str());
        return false;
    }

    JsonObject f = flights[0].as<JsonObject>();
    outInfo.ident = safeGetString(f, "ident");
    outInfo.ident_icao = safeGetString(f, "ident_icao");
    outInfo.operator_code = safeGetString(f, "operator");
    outInfo.operator_icao = safeGetString(f, "operator_icao");
    outInfo.operator_iata = safeGetString(f, "operator_iata");
    outInfo.aircraft_code = safeGetString(f, "aircraft_type");

    if (f.containsKey("origin") && f["origin"].is<JsonObject>())
    {
        JsonObject o = f["origin"].as<JsonObject>();
        outInfo.origin.code_icao = safeGetString(o, "code_icao");
        outInfo.origin.code_iata = safeGetString(o, "code_iata");
    }

    if (f.containsKey("destination") && f["destination"].is<JsonObject>())
    {
        JsonObject d = f["destination"].as<JsonObject>();
        outInfo.destination.code_icao = safeGetString(d, "code_icao");
        outInfo.destination.code_iata = safeGetString(d, "code_iata");
    }

    // Live telemetry from last reported position (Flights-mode metrics).
    if (f.containsKey("last_position") && f["last_position"].is<JsonObject>())
    {
        JsonObject p = f["last_position"].as<JsonObject>();
        if (!p["altitude"].isNull())
        {
            // AeroAPI reports altitude in hundreds of feet.
            outInfo.altitude_ft = p["altitude"].as<double>() * 100.0;
        }
        if (!p["groundspeed"].isNull())
        {
            outInfo.groundspeed_kt = p["groundspeed"].as<double>();
        }
        if (!p["heading"].isNull())
        {
            outInfo.heading_deg = p["heading"].as<double>();
        }
        // altitude_change: "C" climbing, "D" descending, "-" level. No magnitude.
        if (!p["altitude_change"].isNull())
        {
            String ch = String(p["altitude_change"].as<const char *>());
            if (ch == "C")
                outInfo.vertical_rate_fpm = 1.0; // sign-only indicator
            else if (ch == "D")
                outInfo.vertical_rate_fpm = -1.0;
            else
                outInfo.vertical_rate_fpm = 0.0;
        }
    }

    return true;
}
