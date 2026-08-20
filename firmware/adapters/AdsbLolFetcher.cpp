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
#include "utils/ServerJson.h"
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

// Optional numeric field -> value-or-NAN, mirroring FlightWallServerFetcher's
// optNum(). ArduinoJson's `a["field"] | NAN` idiom TYPE-CHECKS before
// converting (is<float>() must hold, or the default wins) -- but `.isNull() ?
// NAN : .as<double>()`, used elsewhere in this file until now, does NOT: it
// only null-checks. A present-but-wrong-typed value (a JSON `true`, an array,
// an object -- adsb.lol is a third-party feed we don't control) silently
// coerces under .as<double>(): true becomes 1.0, an array/object becomes 0.0.
// 0.0 in an altitude field renders as sea level -- the exact "silently renders
// as fact" failure the "ground" string sentinel below exists to prevent, just
// arriving through a different, less obvious door. Routing every numeric read
// through this makes a wrong-typed value degrade to unknown, matching the
// discipline the "ground" handling already applies to alt_baro's string case.
static double optNum(JsonObject o, const char *key)
{
    JsonVariant v = o[key];
    const bool present = !v.isNull() && v.is<float>();
    return optionalNumber(present, present ? v.as<double>() : NAN);
}

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
        s.lat = optNum(a, "lat");
        s.lon = optNum(a, "lon");
        if (isnan(s.lat) || isnan(s.lon))
            continue;

        s.icao24 = String(a["hex"] | "");
        s.icao24.toLowerCase();
        s.callsign = String(a["flight"] | "");
        s.callsign.trim();

        // alt_baro is the STRING "ground" for surface aircraft, not a number.
        // Reading it as a number yields 0, which renders as sea level. This is
        // a documented SENTINEL, not a type error, so it is handled separately
        // from -- and before -- the type-safe optNum() read below.
        JsonVariant alt = a["alt_baro"];
        if (alt.is<const char *>())
        {
            s.on_ground = true;
            s.baro_altitude = NAN;
        }
        else
        {
            s.on_ground = false;
            double ft = optNum(a, "alt_baro");
            if (isnan(ft))
                ft = optNum(a, "alt_geom");
            s.baro_altitude = isnan(ft) ? NAN : ft * kFeetToMeters;
        }
        s.geo_altitude = s.baro_altitude;

        double gsKt = optNum(a, "gs");
        s.velocity = isnan(gsKt) ? NAN : gsKt * kKnotsToMetersPerSec;
        s.heading = optNum(a, "track");

        double rateFpm = optNum(a, "baro_rate");
        if (isnan(rateFpm))
            rateFpm = optNum(a, "geom_rate");
        s.vertical_rate = isnan(rateFpm) ? NAN : rateFpm * kFpmToMetersPerSec;

        // Inline, and the reason this source removes the aircraft lookup: type
        // is keyed by ICAO24 (the airframe), the one enrichment field that was
        // already 100% reliable.
        s.aircraft_type = String(a["t"] | "");
        s.registration = String(a["r"] | "");

        // adsb.lol encodes the ADS-B emitter category as a STRING ("A7" =
        // rotorcraft); OpenSky uses an integer (8 = rotorcraft) and
        // StateVector::category is the OpenSky integer. Translate, or the
        // helicopter check is silently dead for this source.
        //
        // Only category-SET A is mapped here. Live sampling also shows
        // category-set B and beyond on the wire (e.g. "B4", ultralight/
        // hang-glider under the ADS-B emitter-category scheme) -- those are
        // real, valid categories, just not ones OpenSky's integer scheme (or
        // the helicopter check) has a slot for. The cat[0]=='A' guard below
        // already leaves s.category at its 0 default for anything outside set
        // A, which is the correct outcome: deliberately ignored, not mismapped
        // onto a set-A meaning that doesn't apply to it.
        const char *cat = a["category"] | "";
        if (cat[0] == 'A' && cat[1] >= '0' && cat[1] <= '7')
            s.category = (cat[1] - '0') + 1; // A0->1 .. A7->8, matching OpenSky

        // Precomputed by the source, in nm/degrees from the query point.
        double dstNm = optNum(a, "dst");
        s.distance_km = isnan(dstNm) ? haversineKm(centerLat, centerLon, s.lat, s.lon)
                                     : dstNm * kNmToKm;
        double dirDeg = optNum(a, "dir");
        s.bearing_deg = isnan(dirDeg) ? computeBearingDeg(centerLat, centerLon, s.lat, s.lon)
                                      : dirDeg;

        // NOT set: this source carries no route, so enrichment must still run.
        // has_inline_enrichment means "the feed carried a ROUTE".
        s.has_inline_enrichment = false;

        outStateVectors.push_back(s);
    }

    Serial.printf("[fetch] adsb.lol: %u flights in radius\n", (unsigned)outStateVectors.size());
    return true;
}
