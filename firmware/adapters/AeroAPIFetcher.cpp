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

bool AeroAPIFetcher::fetchFlightInfo(const String &flightIdent, FlightInfo &outInfo)
{
    if (g_settings.aeroApiKey.length() == 0)
    {
        Serial.println("AeroAPIFetcher: No API key configured");
        return false;
    }

    WiFiClientSecure client;
    if (APIConfiguration::AEROAPI_INSECURE_TLS)
    {
        client.setInsecure();
    }

    HTTPClient http;
    String url = String(APIConfiguration::AEROAPI_BASE_URL) + "/flights/" + flightIdent;
    http.begin(client, url);
    http.addHeader("x-apikey", g_settings.aeroApiKey.c_str());
    http.addHeader("Accept", "application/json");

    int code = http.GET();
    if (code != 200)
    {
        Serial.printf("AeroAPIFetcher: HTTP request failed with code %d for flight %s\n", code, flightIdent.c_str());
        http.end();
        return false;
    }

    String payload = http.getString();
    http.end();

    DynamicJsonDocument doc(16384);
    DeserializationError err = deserializeJson(doc, payload);
    if (err)
    {
        Serial.printf("AeroAPIFetcher: JSON parsing failed for flight %s: %s\n", flightIdent.c_str(), err.c_str());
        return false;
    }

    JsonArray flights = doc["flights"].as<JsonArray>();
    if (flights.isNull() || flights.size() == 0)
    {
        Serial.printf("AeroAPIFetcher: No flights found in response for %s\n", flightIdent.c_str());
        return false;
    }

    JsonObject f = flights[0].as<JsonObject>();
    outInfo.ident = safeGetString(f, "ident");
    outInfo.ident_icao = safeGetString(f, "ident_icao");
    outInfo.ident_iata = safeGetString(f, "ident_iata");
    outInfo.operator_code = safeGetString(f, "operator");
    outInfo.operator_icao = safeGetString(f, "operator_icao");
    outInfo.operator_iata = safeGetString(f, "operator_iata");
    outInfo.aircraft_code = safeGetString(f, "aircraft_type");

    if (f.containsKey("origin") && f["origin"].is<JsonObject>())
    {
        JsonObject o = f["origin"].as<JsonObject>();
        outInfo.origin.code_icao = safeGetString(o, "code_icao");
    }

    if (f.containsKey("destination") && f["destination"].is<JsonObject>())
    {
        JsonObject d = f["destination"].as<JsonObject>();
        outInfo.destination.code_icao = safeGetString(d, "code_icao");
    }

    // Live telemetry from last reported position (Flights-mode metrics).
    if (f.containsKey("last_position") && f["last_position"].is<JsonObject>())
    {
        JsonObject p = f["last_position"].as<JsonObject>();
        if (!p["altitude"].isNull())
        {
            // AeroAPI reports altitude in hundreds of feet.
            outInfo.altitude_ft = p["altitude"].as<double>() * 100.0;
            outInfo.has_metrics = true;
        }
        if (!p["groundspeed"].isNull())
        {
            outInfo.groundspeed_kt = p["groundspeed"].as<double>();
            outInfo.has_metrics = true;
        }
        if (!p["heading"].isNull())
        {
            outInfo.heading_deg = p["heading"].as<double>();
            outInfo.has_metrics = true;
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
