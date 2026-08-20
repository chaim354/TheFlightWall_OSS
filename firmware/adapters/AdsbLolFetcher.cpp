/*
Purpose: Fetch live flights from adsb.lol's open /v2 API.

Row shape (every field optional in practice):
  hex, flight (callsign), r (registration), t (ICAO type), lat, lon,
  alt_baro, alt_geom, gs, track, baro_rate, geom_rate,
  category ("A0".."A7"), dst (nm from query point), dir (bearing)
*/
#include "adapters/AdsbLolFetcher.h"
#include "core/Settings.h"
#include "utils/GeoUtils.h"
#include <esp_heap_caps.h>

static constexpr const char *kHost = "https://api.adsb.lol";

// adsb.lol reports imperial/nautical; StateVector's contract is SI (OpenSky's
// units), so convert on the way in exactly as FlightRadar24Fetcher does.
static constexpr double kFeetToMeters = 1.0 / 3.28084;
static constexpr double kKnotsToMetersPerSec = 1.0 / 1.94384;
static constexpr double kFpmToMetersPerSec = 1.0 / 196.850;
static constexpr double kNmToKm = 1.852;

// Same safety cap as the other parsers: bounds the output vector, not the parse.
static constexpr size_t kMaxFlights = 40;

#if defined(BOARD_HAS_PSRAM)
namespace
{
struct PsramAllocator : ArduinoJson::Allocator
{
    void *allocate(size_t n) override { return heap_caps_malloc(n, MALLOC_CAP_SPIRAM); }
    void deallocate(void *p) override { heap_caps_free(p); }
    void *reallocate(void *p, size_t n) override { return heap_caps_realloc(p, n, MALLOC_CAP_SPIRAM); }
};
} // namespace
#endif

WiFiClientSecure &AdsbLolFetcher::secureClient()
{
    if (!m_secureInit)
    {
        m_secure.setInsecure();           // CA not pinned; matches OpenSky/FR24/HttpJson
        m_secure.setHandshakeTimeout(15); // seconds — bound it against the loop watchdog
        m_secureInit = true;
    }
    m_secure.stop(); // one client, one host at a time
    return m_secure;
}

bool AdsbLolFetcher::fetchStateVectors(double centerLat,
                                       double centerLon,
                                       double radiusKm,
                                       std::vector<StateVector> &outStateVectors)
{
    // adsb.lol takes a radius in NAUTICAL MILES, capped at 250.
    long radiusNm = lround(radiusKm / kNmToKm);
    if (radiusNm < 1) radiusNm = 1;
    if (radiusNm > 250) radiusNm = 250;

    String url = String(kHost) + "/v2/lat/" + String(centerLat, 4) +
                 "/lon/" + String(centerLon, 4) + "/dist/" + String(radiusNm);

    HTTPClient http;
    http.begin(secureClient(), url);
    // HTTP/1.1 deliberately, NOT useHTTP10(true) — see the long note in
    // FlightRadar24Fetcher.cpp. Under 1.0 the body is delimited by connection
    // close, and WiFiClientSecure discards buffered plaintext once close_notify
    // is processed, truncating any response spanning TLS records.
    http.setTimeout(15000);
    http.addHeader("Accept", "application/json");
    http.addHeader("User-Agent", "TheFlightWall/1.0 (+https://github.com/)");

    int code = http.GET();
    if (code != 200)
    {
        Serial.printf("AdsbLolFetcher: HTTP %d\n", code);
        http.end();
        return false;
    }

#if defined(BOARD_HAS_PSRAM)
    static PsramAllocator psramAllocator;
    JsonDocument doc(&psramAllocator);
#else
    JsonDocument doc; // no PSRAM: internal RAM, radius-bound — keep it tight
#endif

    String body = http.getString();
    http.end();
    if (body.length() == 0)
    {
        Serial.println("AdsbLolFetcher: empty body");
        return false;
    }

    DeserializationError err = deserializeJson(doc, body);
    if (err)
    {
        Serial.printf("AdsbLolFetcher: JSON parse error: %s\n", err.c_str());
        return false;
    }

    JsonArray ac = doc["ac"].as<JsonArray>();
    if (ac.isNull())
    {
        Serial.println("AdsbLolFetcher: no 'ac' array");
        return false;
    }

    for (JsonObject a : ac)
    {
        if (outStateVectors.size() >= kMaxFlights)
            break;

        StateVector s;
        s.lat = a["lat"] | NAN;
        s.lon = a["lon"] | NAN;
        if (isnan(s.lat) || isnan(s.lon))
            continue;

        s.icao24 = String(a["hex"] | "");
        s.icao24.toLowerCase();
        s.callsign = String(a["flight"] | "");
        s.callsign.trim();

        // alt_baro is the STRING "ground" for surface aircraft, not a number.
        // Reading it as a number yields 0, which renders as sea level.
        JsonVariant alt = a["alt_baro"];
        if (alt.is<const char *>())
        {
            s.on_ground = true;
            s.baro_altitude = NAN;
        }
        else
        {
            s.on_ground = false;
            double ft = alt.isNull() ? NAN : alt.as<double>();
            if (isnan(ft) && !a["alt_geom"].isNull())
                ft = a["alt_geom"].as<double>();
            s.baro_altitude = isnan(ft) ? NAN : ft * kFeetToMeters;
        }
        s.geo_altitude = s.baro_altitude;

        s.velocity = a["gs"].isNull() ? NAN : a["gs"].as<double>() * kKnotsToMetersPerSec;
        s.heading = a["track"] | NAN;

        JsonVariant vr = a["baro_rate"].isNull() ? a["geom_rate"] : a["baro_rate"];
        s.vertical_rate = vr.isNull() ? NAN : vr.as<double>() * kFpmToMetersPerSec;

        // Inline, and the reason this source removes the aircraft lookup: type
        // is keyed by ICAO24 (the airframe), the one enrichment field that was
        // already 100% reliable.
        s.aircraft_type = String(a["t"] | "");
        s.registration = String(a["r"] | "");

        // adsb.lol encodes the ADS-B emitter category as a STRING ("A7" =
        // rotorcraft); OpenSky uses an integer (8 = rotorcraft) and
        // StateVector::category is the OpenSky integer. Translate, or the
        // helicopter check is silently dead for this source.
        const char *cat = a["category"] | "";
        if (cat[0] == 'A' && cat[1] >= '0' && cat[1] <= '7')
            s.category = (cat[1] - '0') + 1; // A0->1 .. A7->8, matching OpenSky

        // Precomputed by the source, in nm/degrees from the query point.
        s.distance_km = a["dst"].isNull() ? haversineKm(centerLat, centerLon, s.lat, s.lon)
                                          : a["dst"].as<double>() * kNmToKm;
        s.bearing_deg = a["dir"].isNull() ? computeBearingDeg(centerLat, centerLon, s.lat, s.lon)
                                          : a["dir"].as<double>();

        // NOT set: this source carries no route, so enrichment must still run.
        // has_inline_enrichment means "the feed carried a ROUTE".
        s.has_inline_enrichment = false;

        outStateVectors.push_back(s);
    }

    Serial.printf("[fetch] adsb.lol: %u flights in radius\n", (unsigned)outStateVectors.size());
    return true;
}
