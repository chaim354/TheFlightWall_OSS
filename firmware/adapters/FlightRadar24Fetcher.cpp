/*
Purpose: Fetch live flights from Flightradar24's internal feed.js (unofficial).
Responsibilities:
- Build the FR24 bounds string around a center point and GET feed.js with
  browser-like headers (the endpoint 403s without an origin/referer/UA).
- Parse the flight-id-keyed object into StateVector, converting FR24's imperial
  units into StateVector's SI contract (metres, m/s) so the downstream Area-mode
  code — written for OpenSky — needs no changes.
- Carry FR24's inline route/aircraft/airline through the new StateVector fields so
  enrichment can be skipped for these flights.
Inputs: centerLat, centerLon, radiusKm.
Outputs: outStateVectors within radius, with has_inline_enrichment set.

feed.js row layout (index -> field), as of this writing:
  [0] icao24 hex   [1] lat        [2] lon         [3] track deg
  [4] alt ft(baro) [5] gspd kt    [6] squawk      [7] radar
  [8] type ICAO    [9] reg        [10] ts         [11] origin IATA
  [12] dest IATA   [13] flightno  [14] on_ground  [15] vspeed fpm
  [16] callsign    [17] glider    [18] airline ICAO
The object also has scalar keys "full_count" and "version" that are NOT flights.
*/
#include "adapters/FlightRadar24Fetcher.h"
#include "utils/GeoUtils.h"
#include <esp_heap_caps.h>

// ArduinoJson allocator that puts the whole-body feed.js document in PSRAM.
//
// This is THE line that makes FR24-as-source safe. feed.js is a dynamic-keyed
// object, so deserializeJson builds the ENTIRE box of aircraft in RAM before we
// filter (the 40-cap bounds the output vector, not the parse). On a busy JFK box
// that is tens of KB. ArduinoJson's default allocator is plain malloc in sub-4KB
// pool blocks, and arduino-esp32 keeps allocations under CONFIG_SPIRAM_MALLOC_
// ALWAYSINTERNAL (4096) in INTERNAL RAM — so without this the 8MB octal PSRAM would
// go unused and a big feed would still exhaust internal RAM. heap_caps_*(...,
// MALLOC_CAP_SPIRAM) forces every doc allocation (structure AND copied strings)
// into PSRAM. mbedTLS's handshake buffers already move to PSRAM on their own on the
// S3 (they exceed the 4096 threshold), so with this the fetch has no meaningful
// internal-RAM footprint.
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

// FR24 reports imperial; StateVector's contract is SI (OpenSky's units), so invert
// the same constants FlightDataFetcher uses on the way out.
static constexpr double kFeetToMeters = 1.0 / 3.28084;
static constexpr double kKnotsToMetersPerSec = 1.0 / 1.94384;
static constexpr double kFpmToMetersPerSec = 1.0 / 196.850;

// Undocumented but stable enough. faa/mlat/adsb=1 widen coverage; vehicles=0 drops
// ground vehicles; gnd=1 keeps taxiing aircraft (Area mode filters on_ground itself).
static constexpr const char *kFeedHost = "https://data-cloud.flightradar24.com";

WiFiClientSecure &FlightRadar24Fetcher::secureClient()
{
    if (!m_secureInit)
    {
        m_secure.setInsecure();          // FR24 CA not pinned; matches OpenSky/HttpJson
        m_secure.setHandshakeTimeout(15); // seconds — bound it (see header)
        m_secureInit = true;
    }
    m_secure.stop(); // one client, one host at a time
    return m_secure;
}

bool FlightRadar24Fetcher::fetchStateVectors(double centerLat,
                                             double centerLon,
                                             double radiusKm,
                                             std::vector<StateVector> &outStateVectors)
{
    double latMin, latMax, lonMin, lonMax;
    centeredBoundingBox(centerLat, centerLon, radiusKm, latMin, latMax, lonMin, lonMax);

    // FR24 bounds order is north,south,west,east.
    String bounds = String(latMax, 4) + "," + String(latMin, 4) + "," +
                    String(lonMin, 4) + "," + String(lonMax, 4);
    String url = String(kFeedHost) + "/zones/fcgi/feed.js?bounds=" + bounds +
                 "&faa=1&mlat=1&flarm=1&adsb=1&gnd=1&air=1&vehicles=0&estimated=1"
                 "&maxage=14400&gliders=0&stats=0";

    HTTPClient http;
    http.begin(secureClient(), url);
    http.useHTTP10(true); // feed.js is unchunked; lets us stream-parse
    http.setTimeout(15000);
    // These headers are what separate a 200 from a 403 — the endpoint checks them.
    http.addHeader("User-Agent",
                   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/122.0 Safari/537.36");
    http.addHeader("Accept", "application/json");
    http.addHeader("Origin", "https://www.flightradar24.com");
    http.addHeader("Referer", "https://www.flightradar24.com/");

    int code = http.GET();
    if (code != 200)
    {
        Serial.print("FlightRadar24Fetcher: HTTP request failed with code: ");
        Serial.println(code); // 403/429 here means FR24 changed/blocked the feed
        http.end();
        return false;
    }

    // feed.js is a single JSON object with dynamic keys, so (unlike OpenSky's states
    // array) we cannot stream one element at a time — the whole box is parsed at once.
    // On the S3 that whole body lives in PSRAM (see PsramAllocator), so a busy JFK box
    // no longer pressures internal RAM and the radius is not memory-bound.
#if defined(BOARD_HAS_PSRAM)
    static PsramAllocator psramAllocator;
    JsonDocument doc(&psramAllocator);
    const uint32_t psramBefore = ESP.getFreePsram();
#else
    JsonDocument doc; // no PSRAM: internal RAM, radius-bound — keep it tight
#endif
    DeserializationError err = deserializeJson(doc, http.getStream());
    http.end();
    if (err)
    {
        Serial.print("FlightRadar24Fetcher: JSON parse error: ");
        Serial.println(err.c_str());
        return false;
    }

    try
    {
        parseFeedInto(doc, centerLat, centerLon, radiusKm, outStateVectors);
    }
    catch (...)
    {
        outStateVectors.clear();
        Serial.println("FlightRadar24Fetcher: parse aborted (low memory)");
    }

    // First-run sanity: flights kept and where the parse landed. A non-trivial PSRAM
    // delta confirms the doc is in octal RAM (not silently in internal heap); a delta
    // near zero on a busy box means the allocator is NOT being used — investigate.
#if defined(BOARD_HAS_PSRAM)
    Serial.printf("[fetch] FR24: %u flights in radius, doc used ~%u B PSRAM (free %u->%u)\n",
                  (unsigned)outStateVectors.size(),
                  (unsigned)(psramBefore - ESP.getFreePsram()),
                  (unsigned)psramBefore, (unsigned)ESP.getFreePsram());
#else
    Serial.printf("[fetch] FR24: %u flights in radius\n", (unsigned)outStateVectors.size());
#endif
    return true;
}

void FlightRadar24Fetcher::parseFeedInto(JsonDocument &doc, double centerLat,
                                         double centerLon, double radiusKm,
                                         std::vector<StateVector> &out)
{
    JsonObject root = doc.as<JsonObject>();
    if (root.isNull())
        return;

    for (JsonPair kv : root)
    {
        // Skip the two scalar metadata keys; every other key is a flight id -> array.
        JsonArray a = kv.value().as<JsonArray>();
        if (a.isNull() || a.size() < 19)
            continue;

        StateVector s;
        s.icao24 = a[0].isNull() ? String("") : String(a[0].as<const char *>());
        s.icao24.toLowerCase(); // OpenSky reports lowercase hex; keep cache keys aligned
        s.lat = a[1].isNull() ? NAN : a[1].as<double>();
        s.lon = a[2].isNull() ? NAN : a[2].as<double>();
        if (isnan(s.lat) || isnan(s.lon))
            continue;

        s.distance_km = haversineKm(centerLat, centerLon, s.lat, s.lon);
        if (s.distance_km > radiusKm)
            continue; // bounds is a rectangle; enforce the circle like OpenSky does

        s.heading = a[3].isNull() ? NAN : a[3].as<double>();
        // Convert imperial -> SI so StateVector's OpenSky-shaped contract holds.
        s.baro_altitude = a[4].isNull() ? NAN : a[4].as<double>() * kFeetToMeters;
        s.geo_altitude = s.baro_altitude; // FR24 gives one altitude; reuse it
        s.velocity = a[5].isNull() ? NAN : a[5].as<double>() * kKnotsToMetersPerSec;
        s.on_ground = a[14].isNull() ? false : (a[14].as<int>() != 0);
        s.vertical_rate = a[15].isNull() ? NAN : a[15].as<double>() * kFpmToMetersPerSec;

        s.callsign = a[16].isNull() ? String("") : String(a[16].as<const char *>());
        s.callsign.trim();

        // ---- Inline enrichment: the payoff of using FR24 as the source ----
        // These come free in the same response, so Area mode need not call adsbdb.
        s.origin_iata = a[11].isNull() ? String("") : String(a[11].as<const char *>());
        s.dest_iata = a[12].isNull() ? String("") : String(a[12].as<const char *>());
        s.aircraft_type = a[8].isNull() ? String("") : String(a[8].as<const char *>());
        s.airline_icao = a[18].isNull() ? String("") : String(a[18].as<const char *>());
        s.has_inline_enrichment =
            s.origin_iata.length() || s.dest_iata.length() || s.aircraft_type.length();

        s.bearing_deg = computeBearingDeg(centerLat, centerLon, s.lat, s.lon);

        out.push_back(s);
        if (out.size() >= 40) // same safety cap as OpenSky's parser
            break;
    }
}
