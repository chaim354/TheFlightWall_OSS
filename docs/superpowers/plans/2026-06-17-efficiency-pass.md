# Efficiency Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut per-cycle and per-second heap churn and remove dead weight, so the firmware is frugal on the current ESP32 and on the S3 (churn is something PSRAM does NOT fix).

**Architecture:** Targeted, low-risk diffs — no restructuring. Move (not copy) the flights vector, gate rendering on actual change, build the web JSON lazily, replace the `std::map` + wholesale-clear cache with a bounded LRU, fold AeroAPI onto the shared `HttpJson`, and delete unused fields / reconcile default drift.

**Tech Stack:** ESP32/ESP32-S3 Arduino (PlatformIO), ArduinoJson v7. Pure-logic gets host `g++` tests; device code is compile-gated (`pio run -e esp32dev`) + on-device serial.

**Verification baseline:** every task ends with `cd firmware && pio run -e esp32dev 2>&1 | tail -6` showing `[SUCCESS]`. Host tests: `cd firmware && g++ -std=c++17 test/<file>.cpp -o /tmp/t && /tmp/t`. Do not stage anything under `firmware/data/logos/`.

---

## Task 1: Move the flights vector instead of copying it

**Files:** Modify `firmware/src/main.cpp`, `firmware/core/WebConfigServer.h`

The per-cycle copy `g_lastFlights = flights` deep-copies ~5 structs each holding 11 `String`s. `flights` is a throwaway local — move it.

- [ ] **Step 1: Move into the web setter and into g_lastFlights**

In `firmware/src/main.cpp` `doFetchAndRender()`, change:
```cpp
    g_web.setFlightsJson(flightsToJson(flights));
    g_web.setLastFetchInfo(...);

    g_lastFlights = flights;
    g_display.displayFlights(g_lastFlights);
```
to build the JSON before the move, then move:
```cpp
    g_web.setFlightsJson(flightsToJson(flights));
    g_web.setLastFetchInfo(...);                 // keep existing args unchanged

    g_lastFlights = std::move(flights);
    g_display.displayFlights(g_lastFlights);
```
(Order matters: `flightsToJson(flights)` must run BEFORE the move. `flights` is not used after.)

- [ ] **Step 2:** Add `#include <utility>` to main.cpp if not already present (for `std::move`).
- [ ] **Step 3:** Make `WebConfigServer::setFlightsJson` take the string by value + move into the member, so the JSON string is moved not copied. In `firmware/core/WebConfigServer.h`, change `void setFlightsJson(const String &json) { _flightsJson = json; }` to `void setFlightsJson(String json) { _flightsJson = std::move(json); }` (add `#include <utility>` to the header if needed).
- [ ] **Step 4:** Build → `[SUCCESS]`.
- [ ] **Step 5:** Commit `perf: move flights vector + flights JSON instead of copying`.

---

## Task 2: Delete dead StateVector fields + reconcile default-value drift

**Files:** Modify `firmware/models/StateVector.h`, `firmware/core/Settings.h` (and verify against `firmware/config/TimingConfiguration.h`)

- [ ] **Step 1: Remove the 6 never-written, never-read StateVector fields.** In `firmware/models/StateVector.h` delete: `String origin_country;`, `long time_position = 0;`, `long last_contact = 0;`, `long sensors = 0;`, `String squawk;`, `bool spi = false;`. (Verify with `grep -rn "origin_country\|time_position\|last_contact\|\.sensors\|squawk\|\.spi" firmware/ --include=*.cpp --include=*.h` — the only hits should be the struct definition you're editing. `parseStatesInto` in OpenSkyFetcher.cpp does not set them.)

- [ ] **Step 2: Reconcile default drift.** The struct defaults in `Settings.h` disagree with the seed constants used by `Settings::seedDefaults()`. Make the struct defaults MATCH the seed constants (single source of truth):
  - `fetchIntervalSeconds` default in `Settings.h` is `10`; `TimingConfiguration::FETCH_INTERVAL_SECONDS` is `30`. Set the struct default to `30`.
  - `cycleSeconds` default in `Settings.h` is `5`; `DISPLAY_CYCLE_SECONDS` is `3`. Set the struct default to `3`.
  (Read `firmware/config/TimingConfiguration.h` to confirm the exact constant values, then set the `Settings.h` struct member defaults to those same numbers. Do NOT change the config constants.)

- [ ] **Step 3:** Build → `[SUCCESS]`.
- [ ] **Step 4:** Commit `cleanup: drop unused StateVector fields; align Settings defaults with seed constants`.

---

## Task 3: Route AeroAPI through the shared HttpJson client

**Files:** Modify `firmware/adapters/AeroAPIFetcher.h/.cpp`, `firmware/src/main.cpp`

AeroAPI still creates its own per-call `WiFiClientSecure` and `http.getString()` (whole-body). Fold it onto `HttpJson` (which already accepts a custom header for `x-apikey`) so it shares the one persistent TLS client and streams.

- [ ] **Step 1:** Read `firmware/adapters/AeroAPIFetcher.cpp` and `firmware/core/HttpJson.h`. Add `void setHttp(HttpJson *http) { _http = http; }` + `HttpJson *_http = nullptr;` to `AeroAPIFetcher.h` (include `core/HttpJson.h`).
- [ ] **Step 2:** Replace the body of `AeroAPIFetcher::fetchFlightInfo` so the GET goes through `_http->getJson(url, doc, nullptr, nullptr, "x-apikey", g_settings.aeroApiKey.c_str())` instead of the local `WiFiClientSecure`/`HTTPClient`/`getString`/`deserializeJson`. Keep ALL the existing field-extraction logic (ident/operator/aircraft/origin/destination/last_position metrics) operating on the resulting `doc`. Guard `if (!_http || g_settings.aeroApiKey.length()==0) return false;`. Remove the now-unused `<WiFiClientSecure.h>`/`<HTTPClient.h>` includes if present.
- [ ] **Step 3:** In `main.cpp setup()`, add `g_aeroApi.setHttp(&g_http);` next to the existing `g_adsbdb.setHttp(&g_http);`.
- [ ] **Step 4:** Build → `[SUCCESS]`. Confirm `grep -n "getString\|WiFiClientSecure" firmware/adapters/AeroAPIFetcher.cpp` returns nothing.
- [ ] **Step 5:** Commit `refactor(aeroapi): route through shared HttpJson (streamed, one TLS client)`.

---

## Task 4: Replace the map cache with a bounded LRU (no wholesale clear)

**Files:** Create `firmware/utils/LruCache.h` + `firmware/test/test_lru.cpp`; modify `firmware/core/FlightDataFetcher.h/.cpp`

`std::map<String,CacheEntry>` is a tree (one alloc/node) and is `clear()`-ed entirely at 64 entries — a cliff that drops hot entries. Replace with a fixed-capacity LRU so memory is bounded and stable and eviction is least-recently-used.

- [ ] **Step 1 (TDD): write host test** `firmware/test/test_lru.cpp` covering: insert/get returns value; capacity bound never exceeded; inserting beyond capacity evicts the LEAST-recently-used (a `get` counts as use); overwriting an existing key updates in place without growing size. (Use `std::string` keys + `int` values in the test.)
- [ ] **Step 2:** Run it → fails to compile (no `LruCache.h`).
- [ ] **Step 3:** Implement `firmware/utils/LruCache.h` — a header-only, Arduino-free `template<class K, class V> class LruCache` with a fixed `capacity` (ctor arg), `bool get(const K&, V&)` (moves the key to most-recently-used), `void put(const K&, const V&)` (insert/update; evict LRU when full), `size_t size()`. Back it with a `std::list<std::pair<K,V>>` (MRU at front) + a `std::unordered_map<K, iterator>` for O(1) lookup, OR a simple vector with move-to-front (capacity is small, 64). Keep it dependency-light and host-compilable.
- [ ] **Step 4:** Run host test → `ALL PASS`.
- [ ] **Step 5:** Swap the cache in `FlightDataFetcher`. Replace the `std::map<String,CacheEntry> _cache;` member with `LruCache<String, CacheEntry> _cache{64};` (note: `std::unordered_map<String,...>` would need a `std::hash<String>` — using the LRU avoids that; if your LruCache uses unordered_map internally, key it on `std::string` or provide a hash for Arduino `String`). Update `getEnriched` to use `_cache.get(key, entry)` / `_cache.put(key, entry)` and drop the `if (_cache.size() > 64) _cache.clear();` block (capacity is now intrinsic). Preserve the existing positive/negative TTL logic via `cacheActionFor` exactly — the LRU replaces only the storage/eviction, not the freshness policy.
- [ ] **Step 6:** Build → `[SUCCESS]`; re-run host tests.
- [ ] **Step 7:** Commit `perf(cache): bounded LRU instead of std::map + wholesale clear`.

---

## Task 5: Gate rendering on actual change

**Files:** Modify `firmware/adapters/Hub75Display.cpp/.h`

`displayFlights()` runs every 200 ms and rebuilds the canvas (multiple `String` formatters) even when the visible flight hasn't changed. Recompose only when the displayed card actually changes.

- [ ] **Step 1:** Read `Hub75Display.cpp` `displayFlights()` + the cycle-index/timer logic. Identify where `_currentFlightIndex` advances (every `cycleSeconds`).
- [ ] **Step 2:** Add a cheap dirty-check: track the last-composed `(flightIndex, dataVersion)`. Increment a `_dataVersion` whenever a new flight list is supplied (i.e. at the start of `displayFlights` when the vector identity/content changes — simplest: bump it every call from `doFetchAndRender`'s path vs the 200 ms re-render path; or compare a cheap signature like `flights.size()` + first ident). When `displayFlights()` is called and neither the about-to-show index nor the data version changed since the last compose, **return early before rebuilding the canvas** (still do the panel cycle/refresh if the library needs it, but skip the String-building + canvas redraw).
- [ ] **Step 3:** Keep correctness: a new fetch (new data) MUST recompose even at the same index; a cycle advance MUST recompose; brightness changes are handled elsewhere (don't need recompose). Make sure the web framebuffer preview still reflects the current card (it reads the canvas, which is fine as long as we composed on the last change).
- [ ] **Step 4:** Build → `[SUCCESS]`.
- [ ] **Step 5:** Commit `perf(display): recompose canvas only on flight/data change, not every 200ms`.

---

## Task 6: Build the flights JSON lazily

**Files:** Modify `firmware/core/WebConfigServer.h/.cpp`, `firmware/src/main.cpp`

`flightsToJson` runs every fetch even when no browser is polling `/api/flights`. Build it on demand instead.

- [ ] **Step 1:** Give `WebConfigServer` access to the current flights (e.g. `void setFlights(const std::vector<FlightInfo>* flights)` storing a pointer to `g_lastFlights`, OR a `std::function` serializer). Simplest + safe: store a `const std::vector<FlightInfo>* _flights = nullptr;` set once after `g_lastFlights` is assigned, and move `flightsToJson` into a function `WebConfigServer` can call (or pass it as a callback). Read the current `flightsToJson` in main.cpp and `handleGetFlights` in WebConfigServer.cpp first to pick the cleanest seam.
- [ ] **Step 2:** In `handleGetFlights()`, serialize from the stored flights on demand and send; stop pre-building `_flightsJson` every fetch in `doFetchAndRender`. Keep `setLastFetchInfo` (flight count/note) as-is for `/api/status`.
- [ ] **Step 3:** Ensure lifetime safety: `g_lastFlights` is a global that outlives requests, so a pointer is safe; never point at a local. If using `std::move` from Task 1, set the pointer AFTER the move.
- [ ] **Step 4:** Build → `[SUCCESS]`; manually confirm `/api/flights` still returns the same JSON shape (verify the serializer is unchanged).
- [ ] **Step 5:** Commit `perf(web): build /api/flights JSON on demand, not every fetch`.

---

## Task 7: On-device verification

- [ ] **Step 1:** `cd firmware && pio run -e esp32dev -t upload` (monitor closed; "Hash of data verified.").
- [ ] **Step 2:** Watch serial across several cycles. Confirm: flights still enrich + render + cycle correctly; web UI `/api/flights` and `/api/status` still work; no crashes.
- [ ] **Step 3:** Compare `[heapdiag] cycle-start internalFree=` over time vs the pre-pass baseline (~119–127 K, slowly settling) — it should be **flatter / higher** (less churn). Note the numbers.
- [ ] **Step 4:** Confirm the display no longer re-renders visibly every 200 ms (cycling still advances at `cycleSeconds`).
- [ ] **Step 5:** Commit any notes; then re-advance `main` to the branch tip and decide finish via `superpowers:finishing-a-development-branch`.

---

## Self-Review

- **Coverage:** std::move (T1), dead fields + default drift (T2), AeroAPI→HttpJson (T3), cache swap (T4), render-gating (T5), lazy JSON (T6), verify (T7) — all six ranked wins covered.
- **Risk order:** trivial/low-risk first (T1, T2, T3), medium with tests/gates after (T4 host-tested, T5/T6 compile+device). Each task is independently committable and revertible.
- **No placeholders in the trivial tasks;** T4–T6 give precise seams + acceptance criteria and instruct the implementer to read the specific functions first (the two-stage review backstops integration details).
- **Frugal intent preserved:** every task reduces churn or footprint; none moves work to PSRAM (that's the separate S3 cutover) or adds allocation.
