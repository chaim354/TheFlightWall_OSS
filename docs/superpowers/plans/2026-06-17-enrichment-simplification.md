# Enrichment Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the `? → ?` blank-route bug and the JFK OOM by replacing the 5-layer per-request-TLS enrichment chain with a single shared streaming HTTPS client, one live route lookup, local static identity, and a correct positive/negative cache.

**Architecture:** Introduce one persistent `WiFiClientSecure` wrapped in an `HttpJson` helper (allocated once, reused for every request, streams the body straight into ArduinoJson via `useHTTP10(true)`). All fetchers use it. The enrichment chain collapses to: **(local) callsign-prefix → operator_icao + logo**, **(one network call) adsbdb route → hexdb route fallback**, **(network) aircraft type adsbdb → hexdb**. The FlightWall CDN layer and area-mode AeroAPI are removed. The cache stops poisoning itself with prefix-only "successes" and uses a short negative TTL so transient failures retry.

**Tech Stack:** ESP32 / Arduino (PlatformIO), ArduinoJson v7.4.2, mbedTLS via `WiFiClientSecure`, `HTTPClient`. Pure-logic unit tests compile on the host with `g++` (no hardware needed).

**Root cause being fixed (evidence):** TLS handshakes need a ~16 KB *contiguous* heap block; `OpenSkyFetcher` calls `getString()` on the 100 KB+ states body first, fragmenting the heap, so every subsequent enrichment handshake fails (`http.GET()` → -1). The flight still shows because the logo/prefix path needs no heap. `AdsbdbFetcher::fetchFlightInfo` returns `ok=true` on prefix-only success, and `FlightDataFetcher::getEnriched` caches that empty result as `valid` for 600 s, making the failure stick.

---

## File Structure

**New:**
- `firmware/utils/CallsignUtils.h` — Arduino-free pure logic: airline-prefix parse + cache-action policy. Host-testable.
- `firmware/core/HttpJson.h` / `HttpJson.cpp` — shared persistent streaming HTTPS+JSON client.
- `firmware/test/test_parsers.cpp` — host `g++` unit tests for `CallsignUtils.h`.

**Modified:**
- `firmware/adapters/OpenSkyFetcher.cpp/.h` — stream the states body (no `getString()`); take an `HttpJson*`.
- `firmware/adapters/AdsbdbFetcher.cpp/.h` — use `HttpJson`; collapse to route + aircraft only; drop prefix-sets-ok.
- `firmware/core/FlightDataFetcher.cpp/.h` — apply prefix locally for every flight; positive/negative cache; drop `enrichNames`/CDN; remove area-mode AeroAPI.
- `firmware/src/main.cpp` — own a global `HttpJson g_http`; inject into fetchers; drop FlightWall wiring.

**Deleted:**
- `firmware/adapters/FlightWallFetcher.cpp/.h` — redundant (adsbdb already returns the airline name; aircraft shows raw ICAO type).

---

## Task 1: Extract pure callsign/cache logic with host tests

**Files:**
- Create: `firmware/utils/CallsignUtils.h`
- Test: `firmware/test/test_parsers.cpp`

- [ ] **Step 1: Write the failing test**

Create `firmware/test/test_parsers.cpp`:

```cpp
// Host unit tests for CallsignUtils.h — compile with g++, no hardware.
#include "../utils/CallsignUtils.h"
#include <cstdio>
#include <cstring>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    char out[4];

    // Airline-format callsigns -> 3-letter ICAO prefix
    CHECK(parseAirlineIcao("AAL2960", out) && strcmp(out, "AAL") == 0);
    CHECK(parseAirlineIcao("AFR8F", out)   && strcmp(out, "AFR") == 0);
    CHECK(parseAirlineIcao("qfa3", out)    && strcmp(out, "QFA") == 0);   // lowercase -> upper
    CHECK(parseAirlineIcao("  DAL123 ", out) && strcmp(out, "DAL") == 0); // leading space

    // Tail numbers / junk -> no prefix
    CHECK(!parseAirlineIcao("N172SP", out));   // 4th char not a digit
    CHECK(!parseAirlineIcao("AA", out));       // too short
    CHECK(!parseAirlineIcao("", out));
    CHECK(!parseAirlineIcao(nullptr, out));

    // Cache action policy
    CHECK(cacheActionFor(false, false, 0,      600000, 60000) == CacheAction::Fetch);        // miss
    CHECK(cacheActionFor(true,  true,  100000, 600000, 60000) == CacheAction::UseValid);     // fresh positive
    CHECK(cacheActionFor(true,  true,  700000, 600000, 60000) == CacheAction::Fetch);        // expired positive
    CHECK(cacheActionFor(true,  false, 30000,  600000, 60000) == CacheAction::SkipNegative); // fresh negative
    CHECK(cacheActionFor(true,  false, 90000,  600000, 60000) == CacheAction::Fetch);        // expired negative -> retry

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd firmware && g++ -std=c++17 test/test_parsers.cpp -o /tmp/test_parsers && /tmp/test_parsers`
Expected: FAIL to compile — `CallsignUtils.h: No such file or directory`.

- [ ] **Step 3: Write minimal implementation**

Create `firmware/utils/CallsignUtils.h`:

```cpp
#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h.
#include <cctype>
#include <cstddef>

// Airline ICAO from an airline-format callsign: "QFA3"->"QFA", "AAL2960"->"AAL".
// Tail numbers like "N172SP" (4th char not a digit) yield no prefix.
// Skips leading spaces. Writes 3 uppercase letters + NUL into out[4].
// Returns true iff a prefix was found.
inline bool parseAirlineIcao(const char *callsign, char out[4])
{
    out[0] = '\0';
    if (!callsign)
        return false;
    const char *c = callsign;
    while (*c == ' ')
        c++;
    auto isAlpha = [](char ch) { return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'); };
    if (!isAlpha(c[0]) || !isAlpha(c[1]) || !isAlpha(c[2]))
        return false;
    if (c[3] < '0' || c[3] > '9') // 4th char must be a digit (flight number)
        return false;
    for (int i = 0; i < 3; ++i)
        out[i] = (char)std::toupper((unsigned char)c[i]);
    out[3] = '\0';
    return true;
}

// Cache freshness decision, separating positive and negative (failure) TTLs so a
// transient enrichment failure retries soon instead of sticking for the full TTL.
enum class CacheAction { UseValid, SkipNegative, Fetch };

inline CacheAction cacheActionFor(bool found, bool valid, unsigned long ageMs,
                                  unsigned long positiveTtlMs, unsigned long negativeTtlMs)
{
    if (!found)
        return CacheAction::Fetch;
    if (valid)
        return ageMs < positiveTtlMs ? CacheAction::UseValid : CacheAction::Fetch;
    return ageMs < negativeTtlMs ? CacheAction::SkipNegative : CacheAction::Fetch;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd firmware && g++ -std=c++17 test/test_parsers.cpp -o /tmp/test_parsers && /tmp/test_parsers`
Expected: `ALL PASS`

- [ ] **Step 5: Commit**

```bash
git add firmware/utils/CallsignUtils.h firmware/test/test_parsers.cpp
git commit -m "feat(enrichment): extract host-tested callsign+cache logic

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Add the shared streaming HTTPS+JSON client

**Files:**
- Create: `firmware/core/HttpJson.h`, `firmware/core/HttpJson.cpp`

- [ ] **Step 1: Create the header**

Create `firmware/core/HttpJson.h`:

```cpp
#pragma once
/*
Purpose: One shared HTTPS+JSON client for all fetchers.
- Owns a single persistent WiFiClientSecure so the ~40KB mbedTLS buffers are
  allocated once (early), not per request. Repeated per-request allocation is
  what fragments the heap and makes later TLS handshakes fail with adequate
  total free heap but no contiguous block.
- Streams the response body directly into ArduinoJson (no whole-body String),
  and forces HTTP/1.0 so servers return an unchunked Content-Length body the
  stream parser can consume (OpenSky's chunked body breaks raw getStream()).
*/
#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

class HttpJson
{
public:
    // Fills `doc` on success. Optional `filter` limits which fields are parsed.
    // Optional bearer token and a single extra header (e.g. AeroAPI x-apikey).
    // Returns true only on HTTP 200 + successful parse. 404 is treated as a
    // silent miss (not logged); other failures log the code + largest free block.
    bool getJson(const String &url, JsonDocument &doc,
                 const JsonDocument *filter = nullptr,
                 const char *bearerToken = nullptr,
                 const char *headerName = nullptr,
                 const char *headerValue = nullptr,
                 uint16_t timeoutMs = 12000);

    int lastStatus() const { return _lastStatus; }

private:
    WiFiClientSecure _secure;
    bool _secureInit = false;
    int _lastStatus = 0;
};
```

- [ ] **Step 2: Create the implementation**

Create `firmware/core/HttpJson.cpp`:

```cpp
#include "core/HttpJson.h"
#include "esp_heap_caps.h"

bool HttpJson::getJson(const String &url, JsonDocument &doc,
                       const JsonDocument *filter,
                       const char *bearerToken,
                       const char *headerName,
                       const char *headerValue,
                       uint16_t timeoutMs)
{
    if (!_secureInit)
    {
        _secure.setInsecure(); // hobby device; no cert pinning (matches prior behavior)
        _secureInit = true;
    }

    HTTPClient http;
    if (!http.begin(_secure, url))
    {
        Serial.printf("HttpJson: begin() failed  %s\n", url.c_str());
        return false;
    }
    http.useHTTP10(true); // unchunked Content-Length body -> safe to stream-parse
    http.setReuse(true);  // keep-alive: reuse the handshake for same-host calls
    http.setTimeout(timeoutMs);
    http.addHeader("Accept", "application/json");
    if (bearerToken)
        http.addHeader("Authorization", String("Bearer ") + bearerToken);
    if (headerName && headerValue)
        http.addHeader(headerName, headerValue);

    int code = http.GET();
    _lastStatus = code;
    if (code != 200)
    {
        if (code != 404) // 404 = "not in this DB" — expected, not an error
            Serial.printf("HttpJson: GET %d (largestFreeBlock=%u)  %s\n", code,
                          (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
                          url.c_str());
        http.end();
        return false;
    }

    DeserializationError err = filter
                                   ? deserializeJson(doc, http.getStream(),
                                                     DeserializationOption::Filter(*filter))
                                   : deserializeJson(doc, http.getStream());
    http.end();
    if (err)
    {
        Serial.printf("HttpJson: parse %s  %s\n", err.c_str(), url.c_str());
        return false;
    }
    return true;
}
```

- [ ] **Step 3: Verify it compiles (added to build, not yet used)**

Run: `cd firmware && pio run -e esp32dev 2>&1 | tail -20`
Expected: `[SUCCESS]` — `HttpJson.cpp` compiles (it's picked up by `build_src_filter +<../core/*.cpp>`).

- [ ] **Step 4: Commit**

```bash
git add firmware/core/HttpJson.h firmware/core/HttpJson.cpp
git commit -m "feat(enrichment): add shared persistent streaming HttpJson client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Stream the OpenSky states body (fixes the OOM + heap fragmentation)

This removes the 100 KB+ `getString()` allocation that fragments the heap before enrichment runs. We stream the outer `states` array element-by-element into the reused per-vector document.

**Files:**
- Modify: `firmware/adapters/OpenSkyFetcher.h`
- Modify: `firmware/adapters/OpenSkyFetcher.cpp`

- [ ] **Step 1: Add the HttpJson dependency to the header**

In `firmware/adapters/OpenSkyFetcher.h`, add the include and a member. Find the existing class declaration and add:

```cpp
#include "core/HttpJson.h"
```

Add a setter and member to the class (public section):

```cpp
    void setHttp(HttpJson *http) { _http = http; }
```

And in the private section:

```cpp
    HttpJson *_http = nullptr;
```

Change the signature of `parseStatesInto` from taking a `const String &payload` to taking a `Stream &`:

```cpp
    void parseStatesInto(Stream &stream, double centerLat, double centerLon,
                         double radiusKm, std::vector<StateVector> &out);
```

- [ ] **Step 2: Replace `fetchStateVectors` to stream**

In `firmware/adapters/OpenSkyFetcher.cpp`, replace the entire `fetchStateVectors` function (lines 165–249) with:

```cpp
bool OpenSkyFetcher::fetchStateVectors(double centerLat,
                                       double centerLon,
                                       double radiusKm,
                                       std::vector<StateVector> &outStateVectors)
{
    if (!ensureAccessToken(false))
    {
        Serial.println("OpenSkyFetcher: ensureAccessToken failed before GET");
        return false;
    }

    double latMin, latMax, lonMin, lonMax;
    centeredBoundingBox(centerLat, centerLon, radiusKm, latMin, latMax, lonMin, lonMax);

    String url = String(APIConfiguration::OPENSKY_BASE_URL) + "/api/states/all?lamin=" + String(latMin, 6) +
                 "&lamax=" + String(latMax, 6) +
                 "&lomin=" + String(lonMin, 6) +
                 "&lomax=" + String(lonMax, 6) +
                 "&extended=1"; // include ADS-B emitter category (index 17; 8 = rotorcraft)

    HTTPClient http;
    http.begin(url); // OpenSky uses its own transport (Bearer token, not via HttpJson)
    http.useHTTP10(true); // unchunked body so we can stream-parse the states array
    http.setTimeout(15000);
    http.addHeader("Authorization", String("Bearer ") + m_accessToken);

    int code = http.GET();
    if (code == 401 && m_accessToken.length() > 0 && ensureAccessToken(true))
    {
        http.end();
        http.begin(url);
        http.useHTTP10(true);
        http.setTimeout(15000);
        http.addHeader("Authorization", String("Bearer ") + m_accessToken);
        code = http.GET();
    }
    if (code != 200)
    {
        Serial.print("OpenSkyFetcher: HTTP request failed with code: ");
        Serial.println(code);
        http.end();
        return false;
    }

    try
    {
        parseStatesInto(http.getStream(), centerLat, centerLon, radiusKm, outStateVectors);
    }
    catch (...)
    {
        outStateVectors.clear();
        Serial.println("OpenSkyFetcher: parse aborted (low memory)");
    }
    http.end();
    return true;
}
```

- [ ] **Step 3: Replace `parseStatesInto` to read from a Stream**

Replace the entire `parseStatesInto` function (lines 251–332) with a stream-based, element-by-element parser:

```cpp
void OpenSkyFetcher::parseStatesInto(Stream &stream, double centerLat, double centerLon,
                                     double radiusKm, std::vector<StateVector> &out)
{
    // Seek to the start of the states array, then parse ONE inner array at a
    // time into a reused tiny document (never the whole response in RAM).
    if (!stream.find("\"states\":["))
        return; // no states array (e.g. {"time":..,"states":null})

    JsonDocument sdoc; // reused; holds only ONE state vector at a time
    do
    {
        sdoc.clear();
        DeserializationError err = deserializeJson(sdoc, stream);
        if (err)
            break; // hit ']' / malformed — stop
        JsonArray a = sdoc.as<JsonArray>();
        if (a.size() >= 7)
        {
            StateVector s;
            s.icao24 = a[0].as<const char *>();
            s.callsign = a[1].isNull() ? String("") : String(a[1].as<const char *>());
            s.callsign.trim();
            s.lon = a[5].isNull() ? NAN : a[5].as<double>();
            s.lat = a[6].isNull() ? NAN : a[6].as<double>();
            s.baro_altitude = a[7].isNull() ? NAN : a[7].as<double>();
            s.on_ground = a[8].isNull() ? false : a[8].as<bool>();
            s.velocity = a[9].isNull() ? NAN : a[9].as<double>();
            s.heading = a[10].isNull() ? NAN : a[10].as<double>();
            s.vertical_rate = a[11].isNull() ? NAN : a[11].as<double>();
            s.geo_altitude = a[13].isNull() ? NAN : a[13].as<double>();
            s.position_source = a[16].isNull() ? 0 : a[16].as<int>();
            s.category = a[17].isNull() ? 0 : a[17].as<int>(); // extended=1; 8 = rotorcraft

            if (!isnan(s.lat) && !isnan(s.lon))
            {
                s.distance_km = haversineKm(centerLat, centerLon, s.lat, s.lon);
                if (s.distance_km <= radiusKm)
                {
                    s.bearing_deg = computeBearingDeg(centerLat, centerLon, s.lat, s.lon);
                    out.push_back(s);
                }
            }
        }
    } while (out.size() < 40 && stream.findUntil(",", "]"));
}
```

- [ ] **Step 4: Wire the HttpJson member through (compile check)**

`_http` isn't used by OpenSky yet (it keeps its own Bearer transport), but the setter must compile. Run:

Run: `cd firmware && pio run -e esp32dev 2>&1 | tail -20`
Expected: `[SUCCESS]`. If `Stream` is undeclared, add `#include <Stream.h>` to `OpenSkyFetcher.h` (it's transitively available via `Arduino.h`, usually no change needed).

- [ ] **Step 5: Commit**

```bash
git add firmware/adapters/OpenSkyFetcher.h firmware/adapters/OpenSkyFetcher.cpp
git commit -m "perf(opensky): stream states array, drop 100KB getString allocation

Fixes the heap fragmentation that broke downstream enrichment TLS handshakes
and the JFK OOM. useHTTP10(true) makes the chunked body streamable.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Collapse AdsbdbFetcher onto HttpJson; stop prefix-only "success"

The fetcher keeps two responsibilities only: **route** (adsbdb → hexdb) and **aircraft type** (adsbdb → hexdb). The callsign-prefix → `operator_icao` logic moves to the orchestrator (Task 5) so the logo always renders even when the network is down, and so the cache validity reflects *network* data only.

**Files:**
- Modify: `firmware/adapters/AdsbdbFetcher.h`
- Modify: `firmware/adapters/AdsbdbFetcher.cpp`

- [ ] **Step 1: Update the header**

In `firmware/adapters/AdsbdbFetcher.h`, add the include and an injected client. Add near the top:

```cpp
#include "core/HttpJson.h"
```

Add a constructor/setter and member. In the public section:

```cpp
    void setHttp(HttpJson *http) { _http = http; }
```

In the private section:

```cpp
    HttpJson *_http = nullptr;
```

Remove the declaration of `bool httpGetJson(const String &url, String &outPayload);` (no longer used).

- [ ] **Step 2: Replace the implementation file**

Replace the entire contents of `firmware/adapters/AdsbdbFetcher.cpp` with:

```cpp
/*
Purpose: Free flight enrichment via adsbdb.com (+ hexdb.io fallback), no API key.
- /v0/callsign/{cs} -> route (origin/dest ICAO+IATA) and airline name.
- /v0/aircraft/{icao24} -> ICAO aircraft type.
All HTTP goes through the shared streaming HttpJson client. Returns true only
when a NETWORK lookup actually produced route or aircraft data (the caller adds
local callsign-prefix identity separately, so prefix-only is NOT "enriched").
*/
#include "adapters/AdsbdbFetcher.h"

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
    int dash = route.indexOf('-');
    if (dash < 0)
        return false;
    String origin = route.substring(0, dash);
    String dest = route.substring(route.lastIndexOf('-') + 1); // last leg if multi-stop
    origin.trim();
    dest.trim();
    if (origin.length() && out.origin.code_icao.length() == 0)
        out.origin.code_icao = origin;
    if (dest.length() && out.destination.code_icao.length() == 0)
        out.destination.code_icao = dest;
    return origin.length() || dest.length();
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

    // Route: adsbdb first (also gives airline name), then hexdb.io fallback.
    if (flightIdent.length())
    {
        if (fetchRoute(flightIdent, outInfo))
            gotNetworkData = true;
        else if (fetchRouteHexdb(flightIdent, outInfo))
            gotNetworkData = true;
    }

    // Aircraft type: adsbdb first, then hexdb.io fallback.
    if (icao24.length())
    {
        if (fetchAircraft(icao24, outInfo))
            gotNetworkData = true;
        else if (fetchAircraftHexdb(icao24, outInfo))
            gotNetworkData = true;
    }

    // NOTE: callsign-prefix -> operator_icao is applied by the orchestrator
    // (FlightDataFetcher), NOT here, so prefix-only does not count as a network
    // success and never poisons the cache.
    return gotNetworkData;
}
```

Note: this preserves the existing declarations of `fetchRoute`, `fetchAircraft`, `fetchRouteHexdb`, `fetchAircraftHexdb`, `fetchFlightInfo` in the header. The static `airlineIcaoFromCallsign` is removed (moved to `CallsignUtils.h`).

- [ ] **Step 3: Compile check**

Run: `cd firmware && pio run -e esp32dev 2>&1 | tail -20`
Expected: `[SUCCESS]`.

- [ ] **Step 4: Commit**

```bash
git add firmware/adapters/AdsbdbFetcher.h firmware/adapters/AdsbdbFetcher.cpp
git commit -m "refactor(adsbdb): use shared HttpJson; return true only on network data

Prefix-only success no longer counts as enrichment (moved to orchestrator),
removing the cache-poisoning that froze blank routes for 10 minutes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Rework FlightDataFetcher — local prefix always, correct cache, drop CDN + area AeroAPI

**Files:**
- Modify: `firmware/core/FlightDataFetcher.h`
- Modify: `firmware/core/FlightDataFetcher.cpp`

- [ ] **Step 1: Update the header**

In `firmware/core/FlightDataFetcher.h`:
- Add `#include "utils/CallsignUtils.h"` near the other includes.
- Remove the `void enrichNames(FlightInfo &info);` declaration.
- Add a private helper declaration: `void applyLocalIdentity(const String &callsign, FlightInfo &info);`
- Confirm `CacheEntry` has fields `{ FlightInfo info; bool valid; unsigned long ts; }` (unchanged).

- [ ] **Step 2: Replace `getEnriched` with positive/negative cache + remove `enrichNames`**

In `firmware/core/FlightDataFetcher.cpp`, replace the `getEnriched` function (lines 43–82) with:

```cpp
bool FlightDataFetcher::getEnriched(const String &key, const String &callsign,
                                    const String &icao24, FlightInfo &out)
{
    const unsigned long now = millis();
    const unsigned long posTtl = (unsigned long)g_settings.enrichmentCacheSeconds * 1000UL;
    const unsigned long negTtl = 60UL * 1000UL; // retry failures after 60s, not the full TTL

    auto it = _cache.find(key);
    if (it != _cache.end())
    {
        CacheAction act = cacheActionFor(true, it->second.valid, now - it->second.ts, posTtl, negTtl);
        if (act == CacheAction::UseValid)
        {
            out = it->second.info;
            return true;
        }
        if (act == CacheAction::SkipNegative)
            return false; // recent failure; don't re-hammer the provider yet
        // else: expired -> fall through and re-fetch
    }

    BaseFlightFetcher *f = activeFetcher();
    FlightInfo info;
    bool ok = f ? f->fetchFlightInfo(callsign, icao24, info) : false;

    // Backup: if the free source (adsbdb) missed AND a key is set, try AeroAPI.
    if (!ok &&
        g_settings.enrichmentSource == EnrichmentSource::Adsbdb &&
        g_settings.enrichmentFallbackToAeroApi &&
        g_settings.aeroApiKey.length() > 0 && _aeroApi)
    {
        ok = _aeroApi->fetchFlightInfo(callsign, icao24, info);
    }

    if (_cache.size() > 64) // simple bound; aircraft churn over time
        _cache.clear();
    _cache[key] = CacheEntry{info, ok, now};

    if (ok)
        out = info;
    return ok;
}
```

Then **delete** the entire `enrichNames` function (lines 84–109).

- [ ] **Step 3: Add `applyLocalIdentity` helper**

Add this function to `firmware/core/FlightDataFetcher.cpp` (e.g. just after `getEnriched`):

```cpp
// Local, network-free identity from the broadcast callsign: airline ICAO prefix
// -> operator_icao (drives the logo). Always applied so a flight still shows its
// airline/logo even when route/aircraft network lookups fail.
void FlightDataFetcher::applyLocalIdentity(const String &callsign, FlightInfo &info)
{
    char prefix[4];
    if (parseAirlineIcao(callsign.c_str(), prefix) && info.operator_icao.length() == 0)
        info.operator_icao = prefix;
}
```

- [ ] **Step 4: Apply local identity in area mode regardless of enrichment result**

In `fetchAreaMode`, replace the enrichment/skip block (current lines 168–178) with:

```cpp
        // Cache key prefers the stable ICAO24, falling back to callsign.
        const String key = s.icao24.length() ? s.icao24 : s.callsign;
        FlightInfo info;
        getEnriched(key, s.callsign, s.icao24, info); // network route/aircraft (best-effort)

        // Local, free identity (logo) is applied whether or not the network
        // lookup succeeded — so airliners always show their logo/airline.
        applyLocalIdentity(s.callsign, info);

        // Only suppress a card when enrichment is OFF *and* nothing local resolved?
        // No: in Area mode we always show the flight (callsign + metrics + logo).
```

Note the behavior change: in Area mode we now **always** display each candidate flight (callsign + live metrics + logo), with route/aircraft filled when the network provides them. This removes the old `continue` that hid every flight when enrichment failed — the actual cause of the all-blank screen being worse than it needed to be. The `passesAirlineAllowList(info)` check below this block is unchanged and still applies.

- [ ] **Step 5: Apply local identity in flights mode too**

In `fetchFlightsMode`, after the `getEnriched(...)` call and its `if (!ok)` block, add before `passesAirlineAllowList`:

```cpp
        applyLocalIdentity(ident, info);
```

- [ ] **Step 6: Compile check**

Run: `cd firmware && pio run -e esp32dev 2>&1 | tail -20`
Expected: `[SUCCESS]`. If `enrichNames` is referenced anywhere else, grep and remove: `grep -rn enrichNames firmware/` should return nothing.

- [ ] **Step 7: Commit**

```bash
git add firmware/core/FlightDataFetcher.h firmware/core/FlightDataFetcher.cpp
git commit -m "refactor(enrichment): local identity always, negative cache, drop CDN names

Logos/airline now resolve locally for every flight; transient network failures
retry after 60s instead of sticking 10min; FlightWall CDN name lookups removed
(adsbdb already returns the airline name; aircraft shows its ICAO type code).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire the shared client in main.cpp and delete FlightWallFetcher

**Files:**
- Modify: `firmware/src/main.cpp`
- Delete: `firmware/adapters/FlightWallFetcher.cpp`, `firmware/adapters/FlightWallFetcher.h`

- [ ] **Step 1: Inspect current globals/wiring**

Run: `cd firmware && grep -n "g_openSky\|g_adsbdb\|g_aeroApi\|FlightWall\|HttpJson\|g_http\|g_fetcher" src/main.cpp`
Expected: shows the global fetcher instances and the `FlightDataFetcher g_fetcher(...)` construction. Use the real variable names from this output in the next steps (the names below match the audit: `g_openSky`, `g_aeroApi`, `g_adsbdb`, `g_fetcher`).

- [ ] **Step 2: Add the shared client and inject it**

In `firmware/src/main.cpp`, add the include near the top:

```cpp
#include "core/HttpJson.h"
```

Add a global instance alongside the other fetcher globals:

```cpp
HttpJson g_http;
```

In `setup()` (after the globals are constructed, before the first fetch), inject the client into the fetchers that now use it:

```cpp
    g_openSky.setHttp(&g_http);
    g_adsbdb.setHttp(&g_http);
```

- [ ] **Step 3: Remove FlightWall references**

Run: `cd firmware && grep -rn "FlightWall" src/ core/ adapters/ | grep -iv "flightwall-setup\|flightwall.local\|TheFlightWall\|FLIGHTWALL_"`
Expected: any code references to `FlightWallFetcher` (include, instantiation). Remove them from `main.cpp` and anywhere else they appear. The `FLIGHTWALL_*` constants in `APIConfiguration.h` and the AP/mDNS names are unrelated — leave them.

- [ ] **Step 4: Delete the dead files**

```bash
cd firmware && rm adapters/FlightWallFetcher.cpp adapters/FlightWallFetcher.h
```

- [ ] **Step 5: Compile check**

Run: `cd firmware && pio run -e esp32dev 2>&1 | tail -25`
Expected: `[SUCCESS]`. Resolve any remaining references to the deleted file.

- [ ] **Step 6: Re-run host unit tests (guard against regressions in pure logic)**

Run: `cd firmware && g++ -std=c++17 test/test_parsers.cpp -o /tmp/test_parsers && /tmp/test_parsers`
Expected: `ALL PASS`

- [ ] **Step 7: Commit**

```bash
git add -A firmware/src/main.cpp
git rm firmware/adapters/FlightWallFetcher.cpp firmware/adapters/FlightWallFetcher.h
git commit -m "refactor: wire shared HttpJson into fetchers; delete FlightWallFetcher

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: On-device verification

No automated harness exists for the networked paths; verify on hardware with the serial monitor and the web UI. **Reflash both firmware and filesystem**, and confirm the upload actually landed (per HANDOFF §2, a prior "fix" was tested on a stale binary).

- [ ] **Step 1: Flash firmware (monitor closed) and confirm it landed**

Run: `cd firmware && pio run -e esp32dev -t upload 2>&1 | tail -15`
Expected: `Hash of data verified.` and `[SUCCESS]`. (Close any open serial monitor first.)

- [ ] **Step 2: Watch one fetch cycle on serial**

Run: `cd firmware && pio device monitor -b 115200`
Expected within ~30 s:
- `Enriched flights:` line with a non-zero count.
- **No** `HttpJson: GET -1 ...` lines (or if present, note the `largestFreeBlock=` value — it should be ≫ 16000).
- No `parse aborted (low memory)` near JFK.

- [ ] **Step 3: Confirm routes via the web UI / API**

Open `http://flightwall.local/api/flights` (or the web UI). 
Expected: airliner cards now show `origin → destination` (e.g. `KBOS → KLAX` for an AAL flight, `LFPG → KJFK` for an AFR flight) and the airline/logo. `? → ?` should be gone for flights whose route is in adsbdb/hexdb. GA/tail-number flights may still show `? → ?` (no route exists) — that is correct.

- [ ] **Step 4: Confirm heap headroom under load**

Open `http://flightwall.local/api/status` during a busy cycle.
Expected: `freeHeap` stable across cycles (no steady decline indicating a leak). If a `largestFreeBlock` log was added to status, confirm it stays > ~30 KB.

- [ ] **Step 5: Record the result**

If routes populate and heap is stable, the bug is fixed. If `HttpJson: GET -1` persists with a healthy `largestFreeBlock`, the failure is not heap — capture the serial log and revisit (likely DNS/TLS to a specific host); do not assume.

- [ ] **Step 6: Final commit / branch wrap**

```bash
git add -A && git commit -m "docs: record on-device verification of enrichment rework

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Then use `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-Review

**Spec coverage:**
- Persistent reused TLS client → Task 2 (`HttpJson`), wired Task 6. ✓
- Streaming parse (no `getString`) → Task 3 (OpenSky), Task 2/4 (enrichment via `HttpJson`). ✓
- Collapse the chain (drop CDN, drop area AeroAPI behavior is retained only as keyed backup) → Tasks 4–6. ✓ (AeroAPI kept as opt-in backup when a key is set, matching existing setting; not removed outright to avoid breaking Flights mode.)
- Cache poisoning fix (prefix-only no longer "valid", negative TTL) → Tasks 1, 4, 5. ✓
- Local identity/logo always shows → Task 5. ✓
- Heap instrumentation (`largestFreeBlock`) → Task 2. ✓
- Host tests for the bug-prone pure logic → Task 1. ✓

**Placeholder scan:** No TBD/"handle errors"/"similar to" — every code step has complete code. ✓

**Type consistency:** `parseAirlineIcao(const char*, char[4])`, `cacheActionFor(...)→CacheAction`, `HttpJson::getJson(...)`, `setHttp(HttpJson*)`, `applyLocalIdentity(const String&, FlightInfo&)` are used identically wherever referenced. `CacheEntry{info, ok, now}` matches the existing struct. ✓

**Open risk to verify on-device (not a plan gap):** `useHTTP10(true)` relies on each server honoring HTTP/1.0 with `Content-Length`. OpenSky's chunked body is the known case this fixes; if adsbdb/hexdb misbehave under 1.0, Task 7 Step 2 will surface it (parse error logged) and the fallback is to add `StreamUtils` `ChunkDecodingStream` for that host.
