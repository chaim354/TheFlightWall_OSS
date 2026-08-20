# Firmware: Server Position Source + adsb.lol Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the wall get its whole flight list from one HTTP call to the FlightWall server, with a keyless adsb.lol direct mode as the fallback — so a device with no server and no API keys still works.

**Architecture:** Two new `PositionSource` values. `FlightWallServer` takes a dedicated path in `FlightDataFetcher` that fills `FlightInfo` directly and skips enrichment entirely. `AdsbLol` is an ordinary `BaseStateVectorFetcher` that rides the existing Area-mode pipeline, filling aircraft type and registration inline so no per-flight lookup is needed. ETA reaches the display as two new `FlightInfo` fields.

**Tech Stack:** C++17, PlatformIO (`esp32dev` / `esp32s3`), ArduinoJson 7, host tests compiled with g++.

---

## Scope

Plan **3 of 3** for [the server-mediated route + ETA design](../specs/2026-08-19-server-mediated-route-eta-design.md).

- **Plan 1 — bug fixes.** Done, `8b5075a`..`d869f51`.
- **Plan 2 — the Worker.** [Plan](2026-08-20-flightwall-server-worker.md). This plan depends on its **contract**, not its code.
- **Plan 3 (this one) — firmware.**

### Prerequisite

Plan 2's Task 10 measures what fraction of flights actually receive a route. **If that came in well below ~86%, stop and fix the server first.** Wiring the firmware to a join that is not working buys a device that renders blanks and a much harder debugging problem — the server is diagnosable from a `curl`, the device is not.

You do **not** need a running server to execute Tasks 1–7: every parser is tested against a fixture or by inspection. Tasks 8–9 need one.

## The contract this plan consumes

```
GET /v1/flights?lat=&lon=&radius_km=&max=&units=&exclude_ground=&min_alt_ft=&max_alt_ft=
```
```json
{ "ok": true, "ts": 1787182176, "stale": false,
  "flights": [
    { "cs":"EDV5075", "flt":"DL5075", "al":"Delta", "reg":"N914XJ",
      "ac":"CRJ9", "from":"CVG", "to":"LGA",
      "alt":8025, "spd":314, "hdg":230, "vs":1664,
      "dst":12.4, "brg":291,
      "eta_min":18, "eta_text":"~20m", "eta_src":"physics" }
  ] }
```

Two properties are load-bearing and must survive into the firmware:

- **`ok:false` is not an empty list.** `main.cpp`'s `doFetchAndRender` keeps the previous flights on `ok=false` and blanks only after six stale intervals. An empty *success* wipes the wall. Any parse or transport failure must set `ok=false`, never produce an empty success.
- **An absent field means unknown, and must render blank** — never as `0`. `alt: null` is not sea level.

## File Structure

| File | Responsibility |
|---|---|
| `firmware/utils/ServerJson.h` | **new.** Pure helpers for optional JSON scalars. Host-testable. |
| `firmware/test/test_serverjson.cpp` | **new.** Host tests for the above. |
| `firmware/adapters/AdsbLolFetcher.{h,cpp}` | **new.** Keyless position source; type, registration, distance, bearing inline. |
| `firmware/adapters/FlightWallServerFetcher.{h,cpp}` | **new.** One GET, fills `FlightInfo` directly. |
| `firmware/models/FlightInfo.h` | **modify.** Add `eta_minutes`, `eta_text`. |
| `firmware/models/StateVector.h` | **modify.** Add `registration`. |
| `firmware/core/Settings.{h,cpp}` | **modify.** Two new `PositionSource` values, `serverUrl`. |
| `firmware/core/FlightDataFetcher.{h,cpp}` | **modify.** Server path; adsb.lol in `activeStateFetcher`. |
| `firmware/adapters/Hub75Display.cpp` | **modify.** Render ETA on both card layouts. |
| `firmware/core/WebConfigServer.cpp`, `firmware/data/index.html` | **modify.** Expose the new sources and the server URL. |
| `firmware/src/main.cpp` | **modify.** Construct and inject the two new fetchers. |

## Verification used by every task

```bash
cd firmware && for t in parsers classify lru buttons clock route serverjson; do g++ -std=c++17 -Wall -Wextra test/test_$t.cpp -o /tmp/t_$t && /tmp/t_$t; done
```
```bash
cd firmware && pio run -e esp32dev && pio run -e esp32s3
```

PlatformIO content-hashes its builds, so a fast SUCCESS may be a no-op. When a task changes a header, delete `.pio/build/esp32dev` and `.pio/build/esp32s3` to force a real rebuild.

---

### Task 1: Optional-scalar JSON helpers

Every field in the contract can be absent, and absent means *unknown*, not zero. ArduinoJson's `| 0` default silently turns a missing altitude into sea level. Extract that decision into one tested place rather than repeating a ternary at twenty call sites.

**Files:**
- Create: `firmware/utils/ServerJson.h`
- Create: `firmware/test/test_serverjson.cpp`
- Modify: `HANDOFF.md`

- [ ] **Step 1: Write the failing test**

Create `firmware/test/test_serverjson.cpp`:

```cpp
// Host unit tests for ServerJson.h — compile with g++, no hardware, no ArduinoJson.
#include "../utils/ServerJson.h"
#include <cstdio>
#include <cmath>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    // present -> value, absent -> NAN. Zero is a REAL value, not "unknown".
    CHECK(optionalNumber(true, 8025.0) == 8025.0);
    CHECK(optionalNumber(true, 0.0) == 0.0);      // sea level is not unknown
    CHECK(optionalNumber(true, -1200.0) == -1200.0);
    CHECK(std::isnan(optionalNumber(false, 8025.0)));
    CHECK(std::isnan(optionalNumber(false, 0.0)));

    // A non-finite value on the wire is unknown, not a number to render.
    CHECK(std::isnan(optionalNumber(true, NAN)));
    CHECK(std::isnan(optionalNumber(true, INFINITY)));
    CHECK(std::isnan(optionalNumber(true, -INFINITY)));

    // renderable: what the display asks before printing a number.
    CHECK(renderable(8025.0));
    CHECK(renderable(0.0));
    CHECK(renderable(-1200.0));
    CHECK(!renderable(NAN));
    CHECK(!renderable(INFINITY));

    if (failures == 0) printf("test_serverjson: ALL PASS\n");
    return failures ? 1 : 0;
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd firmware && g++ -std=c++17 test/test_serverjson.cpp -o /tmp/t_serverjson
```

Expected: FAIL to compile — `utils/ServerJson.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/utils/ServerJson.h`:

```cpp
#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h, no ArduinoJson.
#include <cmath>

// Absent means UNKNOWN, and unknown must render blank — never as a number.
//
// ArduinoJson's `doc["alt"] | 0` idiom is wrong for this contract: it turns a
// missing altitude into sea level, a missing speed into stationary, and a
// missing vertical rate into level flight. All three are readings a viewer
// would believe. NAN is the value the display code already treats as
// "do not print" (see formatAltitude / formatHeading), so mapping absence to
// NAN makes every existing consumer do the right thing with no changes.
//
// Zero is deliberately a REAL value: an aircraft on the ground at sea level
// legitimately reports 0 ft, and one in level flight legitimately reports 0 fpm.
inline double optionalNumber(bool present, double value)
{
    if (!present || !std::isfinite(value))
        return NAN;
    return value;
}

// What a renderer should ask before printing. Rejects NAN and both infinities —
// a garbage value on the wire must not reach the panel as "inf".
inline bool renderable(double v)
{
    return std::isfinite(v);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd firmware && g++ -std=c++17 -Wall -Wextra test/test_serverjson.cpp -o /tmp/t_serverjson && /tmp/t_serverjson
```

Expected: `test_serverjson: ALL PASS`.

- [ ] **Step 5: Add the suite to both documented test loops**

`HANDOFF.md` documents the host-test command in two places (lines 23 and 222) and both enumerate suites by name, so a suite not added there silently never runs. Add `serverjson` to both, then run the command you edited verbatim to confirm it works.

- [ ] **Step 6: Commit**

```bash
git add firmware/utils/ServerJson.h firmware/test/test_serverjson.cpp HANDOFF.md
git commit -m "feat(server-source): optional-scalar helpers for the server contract

Absent means unknown, not zero. ArduinoJson's | 0 idiom would render a
missing altitude as sea level and a missing vertical rate as level
flight -- both readings a viewer would believe. Map absence to NAN,
which the display already treats as do-not-print."
```

---

### Task 2: Model fields for ETA and registration

**Files:**
- Modify: `firmware/models/FlightInfo.h`
- Modify: `firmware/models/StateVector.h`

- [ ] **Step 1: Add the ETA fields**

In `firmware/models/FlightInfo.h`, after `bearing_deg` in the live-telemetry block:

```cpp
    // Time remaining to destination. NAN = unknown, and unknown renders blank.
    //
    // Computed, not scheduled: the server models the last 60nm at a nominal
    // 200kt rather than at the aircraft's current groundspeed, because a naive
    // distance/groundspeed runs optimistic by a near-constant ~10 minutes at
    // any cruise range. It cannot know about vectoring, holds or taxi-in, so it
    // is good to roughly +/-5 min enroute and vaguer near the end.
    double eta_minutes = NAN;
    // Pre-rounded display string from the server: "~25m", "~1h10", or "LANDING"
    // inside 30nm. Rendered VERBATIM -- the rounding is the honesty policy, and
    // re-deriving it on device would let the two drift apart.
    String eta_text;
```

- [ ] **Step 2: Add registration**

In `firmware/models/StateVector.h`, alongside the other inline-enrichment fields:

```cpp
    String registration;          // tail number, e.g. "N914XJ", when the feed carries it
```

- [ ] **Step 3: Verify both environments build**

```bash
cd firmware && rm -rf .pio/build/esp32dev .pio/build/esp32s3 && pio run -e esp32dev && pio run -e esp32s3
```

Expected: SUCCESS for both. Note the RAM/flash delta — `FlightInfo` now carries an extra `String` and is held `maxFlights` deep in two vectors.

- [ ] **Step 4: Commit**

```bash
git add firmware/models/FlightInfo.h firmware/models/StateVector.h
git commit -m "feat(server-source): eta_minutes/eta_text on FlightInfo, registration on StateVector"
```

---

### Task 3: Settings — two new position sources and a server URL

**Files:**
- Modify: `firmware/core/Settings.h`
- Modify: `firmware/core/Settings.cpp`
- Modify: `firmware/test/test_logic/test_main.cpp`

- [ ] **Step 1: Extend the enum**

In `firmware/core/Settings.h`:

```cpp
enum class PositionSource : uint8_t
{
    OpenSky = 0,       // default: stable, official, OAuth-key'd public API
    FlightRadar24 = 1, // opt-in UNOFFICIAL scrape of fr24.com's feed.js. Carries
                       // route/aircraft/airline inline (no separate enrichment
                       // call), but violates FR24 ToS and can break/rate-limit.
                       // Never the default; intended for personal use on the S3.
    AdsbLol = 2,       // keyless community ADS-B aggregator. No account, no ToS
                       // problem. Carries ICAO type, registration and a
                       // precomputed distance/bearing inline, so it replaces the
                       // per-flight aircraft lookup as well as the position feed.
                       // Carries NO route -- enrichment still runs for that.
    FlightWallServer = 3, // the FlightWall server does the fetching, joining and
                          // ETA maths and returns a display-ready list. One HTTP
                          // call per cycle instead of up to 1 + 2*maxFlights.
                          // Needs serverUrl; falls back to AdsbLol if unreachable.
};
```

**Existing numeric values must not change.** They are persisted in NVS, so renumbering would silently repoint an existing user's configuration at a different source.

Add alongside the other API settings:

```cpp
    // Base URL of the FlightWall server, e.g. "https://flightwall.example.workers.dev".
    // Stored without a trailing slash (normalised on load). Empty means the
    // server source is unusable and the fetcher falls back to AdsbLol.
    String serverUrl;
```

- [ ] **Step 2: Add the string mapping**

Near the top of `firmware/core/Settings.cpp`:

```cpp
// Round-trips PositionSource through the settings JSON. An unrecognised string
// falls back to OpenSky rather than to whatever enum value happens to be 0 --
// a config written by a NEWER firmware must degrade to the safe default, not to
// an arbitrary source.
static const char *positionSourceToString(PositionSource s)
{
    switch (s)
    {
    case PositionSource::FlightRadar24:    return "fr24";
    case PositionSource::AdsbLol:          return "adsblol";
    case PositionSource::FlightWallServer: return "server";
    case PositionSource::OpenSky:
    default:                               return "opensky";
    }
}

static PositionSource positionSourceFromString(const String &s)
{
    if (s == "fr24")    return PositionSource::FlightRadar24;
    if (s == "adsblol") return PositionSource::AdsbLol;
    if (s == "server")  return PositionSource::FlightWallServer;
    return PositionSource::OpenSky;
}
```

- [ ] **Step 3: Extend serialisation**

Replace the write (around `Settings.cpp:185`):

```cpp
    api["positionSource"] = (positionSource == PositionSource::FlightRadar24) ? "fr24" : "opensky";
```

with:

```cpp
    api["positionSource"] = positionSourceToString(positionSource);
    api["serverUrl"] = serverUrl;
```

Replace the read (around `Settings.cpp:296`):

```cpp
        if (api.containsKey("positionSource"))
        {
            String s = api["positionSource"].as<String>();
            positionSource = (s == "fr24") ? PositionSource::FlightRadar24 : PositionSource::OpenSky;
        }
```

with:

```cpp
        if (api.containsKey("positionSource"))
            positionSource = positionSourceFromString(api["positionSource"].as<String>());
        if (api.containsKey("serverUrl"))
        {
            serverUrl = api["serverUrl"].as<String>();
            serverUrl.trim();
            // A trailing slash would produce "...//v1/flights". Normalise once
            // here rather than defensively at the call site.
            while (serverUrl.endsWith("/"))
                serverUrl.remove(serverUrl.length() - 1);
        }
```

- [ ] **Step 4: Add round-trip coverage**

`firmware/test/test_logic/test_main.cpp` already round-trips settings through `toJson`/`fromJson`. Add a test asserting that each of `"opensky"`, `"fr24"`, `"adsblol"`, `"server"` survives a round trip, that an unrecognised string yields `OpenSky`, and that a `serverUrl` with a trailing slash is stored without one.

That suite runs on-device, so confirm it still compiles:

```bash
cd firmware && pio test -e esp32dev --without-uploading --without-testing
```

- [ ] **Step 5: Build and commit**

```bash
cd firmware && rm -rf .pio/build/esp32dev .pio/build/esp32s3 && pio run -e esp32dev && pio run -e esp32s3
git add firmware/core/Settings.h firmware/core/Settings.cpp firmware/test/test_logic/test_main.cpp
git commit -m "feat(server-source): AdsbLol and FlightWallServer position sources

Existing enum values are unchanged -- they are persisted in NVS, so
renumbering would silently repoint an existing config at a different
source. Unknown strings degrade to OpenSky rather than to enum value 0."
```

---

### Task 4: adsb.lol fetcher

The keyless fallback, and the reason a device with no server and no API keys still works.

**Files:**
- Create: `firmware/adapters/AdsbLolFetcher.h`
- Create: `firmware/adapters/AdsbLolFetcher.cpp`

- [ ] **Step 1: Write the header**

Create `firmware/adapters/AdsbLolFetcher.h`:

```cpp
#pragma once
/*
Purpose: Keyless position source backed by adsb.lol, a community ADS-B
aggregator. No account, no API key, no ToS problem — the data is ODbL-licensed
and the API is explicitly open.

Why it exists alongside OpenSky: one call returns position AND ICAO type AND
registration AND a precomputed distance/bearing from the query point, so it
removes the per-flight aircraft lookup from the cycle as well as replacing the
state feed. Aircraft type is keyed by ICAO24 — the airframe — which is why it
was already the one reliable enrichment field; getting it inline costs nothing
in accuracy and one connection less per flight.

What it does NOT carry is a route. Routes still come from the enrichment source,
or from the FlightWall server when that is selected.

Transport discipline mirrors OpenSkyFetcher: its own WiFiClientSecure with a
BOUNDED handshake, so a stalled TLS negotiation fails fast instead of parking
loopTask until the 120s watchdog reboots the wall.
*/

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "interfaces/BaseStateVectorFetcher.h"

class AdsbLolFetcher : public BaseStateVectorFetcher
{
public:
    AdsbLolFetcher() = default;
    ~AdsbLolFetcher() override = default;

    bool fetchStateVectors(double centerLat,
                           double centerLon,
                           double radiusKm,
                           std::vector<StateVector> &outStateVectors) override;

private:
    WiFiClientSecure m_secure;
    bool m_secureInit = false;
    WiFiClientSecure &secureClient();
};
```

- [ ] **Step 2: Write the implementation**

Create `firmware/adapters/AdsbLolFetcher.cpp`:

```cpp
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
```

- [ ] **Step 3: Verify the category translation against live data**

The A0–A7 mapping is the easiest thing here to get wrong, and getting it wrong makes the helicopter badge either never or always appear.

```bash
curl -s "https://api.adsb.lol/v2/lat/40.64/lon/-73.78/dist/60" | python3 -c "
import json,sys,collections
ac=json.load(sys.stdin)['ac']
print(collections.Counter(a.get('category') for a in ac))
print('A7 rows:', [(a.get('flight','').strip(), a.get('t')) for a in ac if a.get('category')=='A7'][:5])
"
```

The existing rotorcraft check is `s.category == 8` (`FlightDataFetcher.cpp`, `is_helicopter`). Confirm `A7` maps to `8` under the formula. If the observed categories do not fit `A0..A7`, adjust and say so in your report.

- [ ] **Step 4: Build and commit**

```bash
cd firmware && pio run -e esp32dev && pio run -e esp32s3
git add firmware/adapters/AdsbLolFetcher.h firmware/adapters/AdsbLolFetcher.cpp
git commit -m "feat(server-source): keyless adsb.lol position source

Carries ICAO type, registration and precomputed distance/bearing inline,
so it replaces the per-flight aircraft lookup as well as the state feed.
Translates adsb.lol's string emitter category (A7) to OpenSky's integer
(8) so the existing rotorcraft check keeps working. Sets
has_inline_enrichment=false: this source has no route."
```

---

### Task 5: FlightWall server fetcher

**Files:**
- Create: `firmware/adapters/FlightWallServerFetcher.h`
- Create: `firmware/adapters/FlightWallServerFetcher.cpp`

- [ ] **Step 1: Write the header**

Create `firmware/adapters/FlightWallServerFetcher.h`:

```cpp
#pragma once
/*
Purpose: Fetch a complete, display-ready flight list from the FlightWall server
in ONE HTTP call.

Why this is NOT a BaseStateVectorFetcher: it does not return state vectors. The
server has already fetched positions, joined them to airport schedules, rejected
implausible routes, computed ETA, converted units, resolved airline names,
filtered, sorted and capped. What comes back is FlightInfo, so this fills the
output list directly and the whole Area-mode enrichment path is skipped.

What that buys: today one cycle can open 1 + 2*maxFlights TLS connections. That
arithmetic is why kEnrichBudgetMs exists, and it is behind a real coredump with
loopTask parked in start_ssl_client(hostname="hexdb.io") until the 120s watchdog
rebooted the wall. One server means one connection, with keep-alive — the
failure mode is removed by construction rather than bounded by a budget.
*/

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <vector>
#include "models/FlightInfo.h"

class FlightWallServerFetcher
{
public:
    FlightWallServerFetcher() = default;

    // Returns false on transport/parse failure OR when the server itself
    // reports ok:false. The caller must treat false as "keep the previous
    // flights", never as "the sky is empty" — an empty SUCCESS blanks the wall.
    //
    // outStale carries the server's own schedule-staleness flag, for the web UI.
    bool fetchFlights(const String &baseUrl,
                      double centerLat,
                      double centerLon,
                      double radiusKm,
                      uint8_t maxFlights,
                      std::vector<FlightInfo> &outFlights,
                      bool &outStale);

private:
    WiFiClientSecure m_secure;
    bool m_secureInit = false;
    WiFiClientSecure &secureClient();
};
```

- [ ] **Step 2: Write the implementation**

Create `firmware/adapters/FlightWallServerFetcher.cpp`:

```cpp
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
    outStale = doc["stale"] | false;

    JsonArray arr = doc["flights"].as<JsonArray>();
    if (arr.isNull())
        return false; // ok:true with no array is malformed, not an empty sky

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
```

**Before building, confirm the `dst` unit against Plan 2's `enrich.ts`.** It emits nautical miles for `units=imperial` and kilometres for `units=metric`. This code requests imperial and converts; if Plan 2 shipped differently, fix it here and say so.

- [ ] **Step 3: Build and commit**

```bash
cd firmware && pio run -e esp32dev && pio run -e esp32s3
git add firmware/adapters/FlightWallServerFetcher.h firmware/adapters/FlightWallServerFetcher.cpp
git commit -m "feat(server-source): FlightWall server fetcher

Fills FlightInfo directly from one HTTP call -- the server has already
joined, filtered, sorted and computed ETA. ok:false propagates as a
failed fetch so the caller keeps its previous list; an empty success
would blank the wall. dst arrives in nm under units=imperial and is
converted to km, which distance_km is by name."
```

---

### Task 6: Wire both sources into FlightDataFetcher

**Files:**
- Modify: `firmware/core/FlightDataFetcher.h`
- Modify: `firmware/core/FlightDataFetcher.cpp`
- Modify: `firmware/src/main.cpp`

- [ ] **Step 1: Extend the constructor**

In `firmware/core/FlightDataFetcher.h`, add `BaseStateVectorFetcher *adsbLolState` and `FlightWallServerFetcher *server` to the constructor, store them as `_adsbLolState` / `_server`, and add:

```cpp
    // Whether the last fetch's schedule data was flagged stale by the server.
    // Surfaced in the web UI only — a stale schedule still renders normally.
    bool lastFetchStale() const { return _lastStale; }
```

with a `bool _lastStale = false;` member, plus declarations for `fetchServerMode` and `applyLocalClassification`.

- [ ] **Step 2: Refactor `fetchAreaMode` so the source can be forced**

`fetchAreaMode` currently calls `activeStateFetcher()` internally. Extract the body into:

```cpp
size_t fetchAreaModeWith(BaseStateVectorFetcher *src,
                         std::vector<StateVector> &outStates,
                         std::vector<FlightInfo> &outFlights, bool &ok);
```

and make `fetchAreaMode` a one-line call with `activeStateFetcher()`. **Change nothing else about it** — this is a pure extraction so the server fallback can force adsb.lol without mutating the user's settings.

- [ ] **Step 3: Add the dispatch and the server path**

In `fetchFlights`, before the mode dispatch:

```cpp
    _lastStale = false;
    if (g_settings.mode == TrackingMode::Area &&
        g_settings.positionSource == PositionSource::FlightWallServer)
        return fetchServerMode(outStates, outFlights, ok);
```

```cpp
size_t FlightDataFetcher::fetchServerMode(std::vector<StateVector> &outStates,
                                          std::vector<FlightInfo> &outFlights, bool &ok)
{
    // One call, and everything below the wire is already done: joined to the
    // schedule, implausible routes rejected, ETA computed, units converted,
    // sorted nearest-first and capped. No enrichment, no per-flight connection.
    if (_server && _server->fetchFlights(g_settings.serverUrl,
                                         g_settings.centerLat, g_settings.centerLon,
                                         g_settings.radiusKm, g_settings.maxFlights,
                                         outFlights, _lastStale))
    {
        // The server cannot know about the device-side airline allow-list or the
        // cargo/private classification, so those still run here.
        applyLocalClassification(outFlights);
        ok = true;
        return outFlights.size();
    }

    // Server unreachable. Fall back to the keyless direct path for THIS cycle
    // rather than failing: a wall that degrades to callsign-plus-metrics beats
    // one frozen on its last list. The configured source is left unchanged, so
    // the next cycle tries the server again with no user action.
    Serial.println("FlightDataFetcher: server unavailable; falling back to adsb.lol");
    outFlights.clear();
    return fetchAreaModeWith(_adsbLolState ? _adsbLolState : _openSkyState,
                             outStates, outFlights, ok);
}
```

`applyLocalClassification` runs `is_cargo`, `is_private`, `is_helicopter` and `passesAirlineAllowList` over the list. **Extract that block out of `consider()` and call it from both places** rather than duplicating it — two copies will drift, and a flight filtered in one mode but not the other is a bug nobody will reproduce on purpose.

- [ ] **Step 4: Extend `activeStateFetcher`**

```cpp
BaseStateVectorFetcher *FlightDataFetcher::activeStateFetcher()
{
    switch (g_settings.positionSource)
    {
    case PositionSource::FlightRadar24:
        if (_fr24State) return _fr24State;
        break;
    case PositionSource::AdsbLol:
    case PositionSource::FlightWallServer: // server path runs earlier; this is its fallback
        if (_adsbLolState) return _adsbLolState;
        break;
    default:
        break;
    }
    return _openSkyState;
}
```

- [ ] **Step 5: Construct and inject in `main.cpp`**

Add the two includes, two statics beside `g_openSky`/`g_fr24`, and extend the `FlightDataFetcher` construction (around `main.cpp:454`) to pass them.

- [ ] **Step 6: Build both environments and commit**

```bash
cd firmware && rm -rf .pio/build/esp32dev .pio/build/esp32s3 && pio run -e esp32dev && pio run -e esp32s3
git add firmware/core/FlightDataFetcher.h firmware/core/FlightDataFetcher.cpp firmware/src/main.cpp
git commit -m "feat(server-source): dispatch to the server path, fall back to adsb.lol

The server path skips Area-mode enrichment entirely. When the server is
unreachable the cycle drops to keyless adsb.lol rather than failing --
callsign-plus-metrics beats a frozen list -- and the configured source is
left unchanged so the next cycle retries with no user action."
```

---

### Task 7: Render ETA

**Files:**
- Modify: `firmware/core/Settings.h`, `firmware/core/Settings.cpp`
- Modify: `firmware/adapters/Hub75Display.cpp`

- [ ] **Step 1: Add the layout flag**

In `DisplayLayout` in `firmware/core/Settings.h`, beside the other `show*` flags:

```cpp
    bool showEta = true;           // "~1h05" / "LANDING"
```

Add it to the layout serialisation in `Settings.cpp` alongside its neighbours — miss that and the toggle silently fails to persist.

- [ ] **Step 2: Render on the tall card**

In `buildFlightLines` in `Hub75Display.cpp`, immediately after the `showRoute` block — ETA belongs next to the destination it refers to, not buried under the telemetry:

```cpp
    if (L.showEta && f.eta_text.length())
        outLines.push_back(f.eta_text);
```

Render `eta_text` **verbatim**. Do not re-derive it from `eta_minutes`: the rounding is the honesty policy — 5 minutes under an hour, 10 over, `LANDING` inside 30 nm — and a second implementation on device would drift from the server's.

- [ ] **Step 3: Render on the Mini card**

The 128x64 Mini layout builds fixed rows (`buildRow1`, `buildRow2`) rather than a list. Add ETA to whichever row has room, guarded by `L.showEta` and `f.eta_text.length()`, in the same `Label:value` style as its neighbours (`Alt:`, `Spd:`, `Trk:`).

`ETA:~1h05` is 9 characters against a `(_matrixWidth - 2) / 6` column budget — 21 columns at 128px. Check it fits alongside whatever else is on that row before committing to it.

- [ ] **Step 4: Verify no layout regression**

Both card builders are size-sensitive and neither has a host test. Confirm by inspection:
- with `showEta=false`, output is byte-identical to before this task
- with `eta_text` empty — every OpenSky flight, and any server flight with no destination — nothing is added
- the Mini rows do not overflow `botCols` when ETA is present

- [ ] **Step 5: Build and commit**

```bash
cd firmware && rm -rf .pio/build/esp32dev .pio/build/esp32s3 && pio run -e esp32dev && pio run -e esp32s3
git add firmware/core/Settings.h firmware/core/Settings.cpp firmware/adapters/Hub75Display.cpp
git commit -m "feat(server-source): render ETA next to the route

Renders the server's pre-rounded string verbatim rather than
re-deriving it -- the rounding is the honesty policy and a second
implementation would drift from it."
```

---

### Task 8: Web UI and docs

**Files:**
- Modify: `firmware/data/index.html`
- Modify: `firmware/core/WebConfigServer.cpp`
- Modify: `docs/data-sources.md`, `firmware/README.md`

- [ ] **Step 1: Add the sources and the URL field**

In `firmware/data/index.html`, add `adsblol` and `server` options to the `positionSource` select (around line 103) and a `serverUrl` text input. Wire both into the load path (around line 328) **and** the save path (around line 388) — miss either and the setting silently fails to persist.

Describe each honestly, matching the existing copy's tone:
- **adsb.lol** — no key needed, community-run, carries aircraft type and registration but **no route**
- **FlightWall server** — one call per cycle, needs a server URL you run yourself, falls back to adsb.lol if unreachable

- [ ] **Step 2: Surface ETA and the stale flag**

In `WebConfigServer.cpp`'s live-flight JSON (around line 203), add `etaText` and `etaMin` beside the existing metrics, and surface the server's stale flag via `FlightDataFetcher::lastFetchStale()`. The live list is the fastest way to see whether ETA is arriving at all without staring at the panel.

- [ ] **Step 3: Remember the filesystem image**

`tools/gzip_web_assets.py` regenerates `firmware/data/index.html.gz` on every build and the `.gz` is gitignored — edit the source. Deploying UI changes needs **both** `pio run -t upload` and `pio run -t uploadfs`; firmware alone will not update the page.

- [ ] **Step 4: Update the docs**

`docs/data-sources.md`'s position-source table lists only OpenSky and Flightradar24. Add both new rows with the same honesty the existing rows use: what each needs, what it costs, what it does **not** provide. State plainly that adsb.lol carries no route and that the server is infrastructure the user has to run.

- [ ] **Step 5: Build and commit**

```bash
cd firmware && pio run -e esp32dev
git add firmware/data/index.html firmware/core/WebConfigServer.cpp docs/data-sources.md firmware/README.md
git commit -m "feat(server-source): expose the new sources in the web UI and docs"
```

---

### Task 9: Device verification

Nothing in Tasks 1–8 has run on hardware. This is the task the whole plan exists to reach, and the one that cannot be skipped: `HANDOFF.md` already carries a row saying the enrichment path is compile-and-host-test only.

- [ ] **Step 1: Flash firmware and filesystem**

```bash
cd firmware && pio run -e esp32s3 -t upload && pio run -e esp32s3 -t uploadfs
pio device monitor -e esp32s3
```

- [ ] **Step 2: adsb.lol direct, with NO keys configured**

Select adsb.lol, clear the OpenSky credentials, reboot. This is the out-of-the-box experience for anyone who flashes this firmware, so it has to work with nothing configured.

Confirm: flights appear; aircraft type shows without any enrichment call; `[fetch] adsb.lol: N flights` appears each cycle; the helicopter badge appears for a rotorcraft — the `A7`→`8` translation from Task 4. If none is overhead, grep the serial log for a category-8 aircraft instead.

- [ ] **Step 3: Server source, happy path**

Point `serverUrl` at the deployed Worker. Confirm: **one** connection per cycle in the serial log rather than the previous burst; routes appear; ETA renders as `~25m` / `~1h10` / `LANDING`; cycle wall-time drops sharply.

Sanity-check the distances against the web UI's live list — if every flight reads about half what it should, the `dst` unit conversion in Task 5 is wrong in the other direction.

- [ ] **Step 4: Server source, FAILURE path — the important one**

With the server selected, break it: set `serverUrl` to a host that will not resolve.

Confirm the wall **falls back to adsb.lol and keeps rendering** rather than freezing or blanking; that the fallback message appears in the log; and that restoring the URL recovers on the next cycle **without a reboot**.

A silent freeze here is the worst outcome of this whole plan, it is invisible to every test, and it only happens when nobody is watching. Do not skip this step.

- [ ] **Step 5: Watchdog headroom**

The reason the server exists is that a cycle could open 1 + 2×maxFlights TLS connections and park `loopTask` in `start_ssl_client` until the 120s watchdog rebooted the wall.

Over at least 30 minutes on the server source, confirm: no reboot; `[heapdiag]` free and largest-internal-block stable rather than trending down; cycle wall-time well under the 45s enrichment budget.

Then repeat on adsb.lol direct — that path still runs per-flight enrichment and is the one carrying the original risk.

- [ ] **Step 6: Record the result truthfully in HANDOFF.md**

Add a row for this branch in the form the existing rows use, stating what was verified on hardware and what was not. If any step above was skipped, say which. An unqualified DEVICE-VERIFIED that isn't true is worse than no row at all — the last one caused exactly this problem.

- [ ] **Step 7: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: record device verification of the server position source"
```

---

## Done when

- [ ] Seven host suites pass; `esp32dev` and `esp32s3` both build from clean.
- [ ] adsb.lol direct works with **no keys configured at all**.
- [ ] Server source renders routes and ETA from one call per cycle.
- [ ] Server failure falls back to adsb.lol without freezing or blanking.
- [ ] 30 minutes on each source: no reboot, stable heap.
- [ ] `HANDOFF.md` says truthfully what was and was not verified.

## Risks specific to this plan

**The `dst` unit.** The contract sends distance in whichever unit `units` requested; `FlightInfo::distance_km` is kilometres by name. Getting it wrong shows every flight at roughly half its true distance — plausible enough to pass a glance — and silently corrupts the nearest-first ordering the display depends on. Task 5 converts and Task 9 Step 3 checks it.

**The fallback is the least-exercised code that matters most.** It runs only when the server is down, which is exactly when nobody is watching. Task 9 Step 4 is not optional.

**`FlightInfo` grew.** It is copied in several places and now carries an extra `String`, held `maxFlights` deep in two vectors. Watch the heap numbers in Task 9 Step 5 rather than assuming two fields are free.

**Two sources now bypass enrichment for different reasons.** FR24 skips it when its row carries a route; the server skips it entirely. If a third arrives, the branching in `fetchFlights` is where it will get confusing — consider whether it wants a proper strategy split at that point rather than another conditional.
