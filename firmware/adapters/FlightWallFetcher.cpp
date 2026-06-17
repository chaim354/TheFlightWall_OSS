/*
Purpose: Look up human-friendly airline and aircraft names from FlightWall CDN.
Responsibilities:
- HTTPS GET small JSON blobs for airline/aircraft codes and parse display names.
- Provide helpers used by FlightDataFetcher for user-facing labels.
Inputs: Airline ICAO code or aircraft ICAO type.
Outputs: Display name strings (short/full) via out parameters.
*/
#include "adapters/FlightWallFetcher.h"

bool FlightWallFetcher::httpGetJson(const String &url, String &outPayload)
{
    WiFiClientSecure client;
    if (APIConfiguration::FLIGHTWALL_INSECURE_TLS)
    {
        client.setInsecure();
    }

    HTTPClient http;
    http.begin(client, url);
    http.addHeader("Accept", "application/json");

    int code = http.GET();
    if (code != 200)
    {
        if (code != 404) // 404 = code not in the CDN lookup — expected, not an error
            Serial.printf("FlightWallFetcher: GET %d  %s\n", code, url.c_str());
        http.end();
        return false;
    }
    outPayload = http.getString();
    http.end();
    return true;
}

bool FlightWallFetcher::getAirlineName(const String &airlineIcao, String &outDisplayNameFull)
{
    outDisplayNameFull = String("");
    if (airlineIcao.length() == 0)
        return false;

    String url = String(APIConfiguration::FLIGHTWALL_CDN_BASE_URL) + "/oss/lookup/airline/" + airlineIcao + ".json";
    String payload;
    if (!httpGetJson(url, payload))
        return false;

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (err)
        return false;

    if (doc.containsKey("display_name_full"))
    {
        outDisplayNameFull = String(doc["display_name_full"].as<const char *>());
        return outDisplayNameFull.length() > 0;
    }
    return false;
}

bool FlightWallFetcher::getAircraftName(const String &aircraftIcao,
                                        String &outDisplayNameShort,
                                        String &outDisplayNameFull)
{
    outDisplayNameShort = String("");
    outDisplayNameFull = String("");
    if (aircraftIcao.length() == 0)
        return false;

    String url = String(APIConfiguration::FLIGHTWALL_CDN_BASE_URL) + "/oss/lookup/aircraft/" + aircraftIcao + ".json";
    String payload;
    if (!httpGetJson(url, payload))
        return false;

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (err)
        return false;

    if (doc.containsKey("display_name_short"))
    {
        outDisplayNameShort = String(doc["display_name_short"].as<const char *>());
    }
    if (doc.containsKey("display_name_full"))
    {
        outDisplayNameFull = String(doc["display_name_full"].as<const char *>());
    }
    return outDisplayNameShort.length() > 0 || outDisplayNameFull.length() > 0;
}
