/*
Purpose: Implementation of IP-based geolocation via ip-api.com (free, no key).
*/
#include "adapters/GeoLocator.h"

#include <HTTPClient.h>
#include <ArduinoJson.h>

bool GeoLocator::locate(double &lat, double &lon, String &place)
{
    HTTPClient http;
    // Free tier is HTTP-only; we only need lat/lon + a place name.
    http.begin("http://ip-api.com/json/?fields=status,message,lat,lon,city,regionName,country");
    http.setTimeout(8000);

    int code = http.GET();
    if (code != 200)
    {
        http.end();
        Serial.printf("GeoLocator: HTTP %d\n", code);
        return false;
    }
    String payload = http.getString();
    http.end();

    JsonDocument doc;
    if (deserializeJson(doc, payload))
        return false;
    if (String(doc["status"] | "") != "success")
        return false;

    if (doc["lat"].isNull() || doc["lon"].isNull())
        return false;
    lat = doc["lat"].as<double>();
    lon = doc["lon"].as<double>();

    String city = doc["city"] | "";
    String region = doc["regionName"] | "";
    if (city.length() && region.length())
        place = city + ", " + region;
    else
        place = city.length() ? city : region;

    return true;
}
