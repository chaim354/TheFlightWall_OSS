#include "adapters/FlightWallServerFetcher.h"
#include "core/Settings.h"
#include "utils/ServerJson.h"

// Distance arrives in the unit we requested. We request imperial, so dst is in
// NAUTICAL MILES, while FlightInfo::distance_km is kilometres by name and is
// formatted as such. Converting is not optional: skipping it shows every flight
// at roughly half its true distance -- plausible enough to pass a glance, and it
// silently corrupts the nearest-first ordering the display depends on.
static constexpr double kNmToKm = 1.852;

// Optional numeric field -> value-or-NAN. ArduinoJson's `| 0` would turn a
// missing altitude into sea level and a missing vertical rate into level flight.
static double optNum(JsonObject o, const char *key)
{
    JsonVariant v = o[key];
    const bool present = !v.isNull() && v.is<float>();
    return optionalNumber(present, present ? v.as<double>() : NAN);
}

static String optStr(JsonObject o, const char *key)
{
    const char *v = o[key] | "";
    return String(v);
}

WiFiClientSecure &FlightWallServerFetcher::secureClient()
{
    if (!m_secureInit)
    {
        m_secure.setInsecure();
        m_secure.setHandshakeTimeout(15);
        m_secureInit = true;
    }
    m_secure.stop();
    return m_secure;
}

bool FlightWallServerFetcher::fetchFlights(const String &baseUrl,
                                           double centerLat,
                                           double centerLon,
                                           double radiusKm,
                                           uint8_t maxFlights,
                                           std::vector<FlightInfo> &outFlights,
                                           bool &outStale)
{
    outStale = false;
    if (baseUrl.length() == 0)
        return false;

    // The server applies the filters, so pass them through rather than
    // re-filtering on device — that is the entire point of this source.
    String url = baseUrl + "/v1/flights?lat=" + String(centerLat, 5) +
                 "&lon=" + String(centerLon, 5) +
                 "&radius_km=" + String(radiusKm, 1) +
                 "&max=" + String((int)maxFlights) +
                 "&units=imperial" +
                 "&exclude_ground=" + (g_settings.filters.excludeOnGround ? "1" : "0");
    if (g_settings.filters.minAltitudeFt > 0)
        url += "&min_alt_ft=" + String(g_settings.filters.minAltitudeFt);
    if (g_settings.filters.maxAltitudeFt > 0)
        url += "&max_alt_ft=" + String(g_settings.filters.maxAltitudeFt);

    HTTPClient http;
    http.begin(secureClient(), url);
    http.setTimeout(15000);
    http.addHeader("Accept", "application/json");

    int code = http.GET();
    if (code != 200)
    {
        Serial.printf("FlightWallServerFetcher: HTTP %d\n", code);
        http.end();
        return false;
    }

    String body = http.getString();
    http.end();

    // Small by design — the server sends ~2KB, not the ~70KB an area feed does.
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, body);
    if (err)
    {
        Serial.printf("FlightWallServerFetcher: JSON parse error: %s\n", err.c_str());
        return false;
    }

    // A server reporting ok:false has already decided its own data is not
    // trustworthy. Propagate that as a failed fetch so the caller keeps the
    // previous list, rather than rendering whatever partial array came with it.
    if (!(doc["ok"] | false))
    {
        Serial.println("FlightWallServerFetcher: server reported ok:false");
        return false;
    }

    JsonArray arr = doc["flights"].as<JsonArray>();
    if (arr.isNull())
        return false; // ok:true with no array is malformed, not an empty sky

    // Assigned only now that every remaining early-return has already happened:
    // an out-parameter set on a failure path outlives that failure and reaches
    // the caller looking exactly like a valid result, misreporting the state of
    // data the caller is about to discard. FlightDataFetcher::fetchServerMode
    // relies on that not happening -- it treats outStale as meaningful only when
    // this call returns true.
    outStale = doc["stale"] | false;

    for (JsonObject f : arr)
    {
        if (outFlights.size() >= maxFlights)
            break;

        FlightInfo info;
        info.ident = optStr(f, "cs");
        if (info.ident.length() == 0)
            continue; // a card with no identity is not worth a slot

        info.ident_iata = optStr(f, "flt");
        info.airline_display_name_full = optStr(f, "al");
        info.aircraft_code = optStr(f, "ac");
        info.origin.code_iata = optStr(f, "from");
        info.destination.code_iata = optStr(f, "to");

        info.altitude_ft = optNum(f, "alt");
        info.groundspeed_kt = optNum(f, "spd");
        info.heading_deg = optNum(f, "hdg");
        info.vertical_rate_fpm = optNum(f, "vs");
        info.bearing_deg = optNum(f, "brg");

        const double dstNm = optNum(f, "dst");
        info.distance_km = isnan(dstNm) ? NAN : dstNm * kNmToKm;

        info.eta_minutes = optNum(f, "eta_min");
        info.eta_text = optStr(f, "eta_text");
        info.has_metrics = true;

        outFlights.push_back(info);
    }

    Serial.printf("[fetch] server: %u flights%s\n",
                  (unsigned)outFlights.size(), outStale ? " (stale schedule)" : "");
    return true;
}
