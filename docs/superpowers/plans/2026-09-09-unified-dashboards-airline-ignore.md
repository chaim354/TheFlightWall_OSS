# Unified Dashboards and Airline Ignore List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every control on both the device page and the server page (except WiFi), plus an "airlines to ignore" list that hides operators such as NetJets on every position source.

**Architecture:** The ignore list is a device setting (`filters.airlineDenyList`) applied in the shared `classifyAndFilter` path and also passed to `/v1/flights` so the server's nearest-N cut respects it. Parity is achieved in both directions: the server page gains the device-only fields (queued through the existing check-in), and the device page gains the server-only cards by calling the server directly from the browser, which the server permits with CORS on its two browser-facing route families.

**Tech Stack:** Firmware: arduino-esp32 2.0.17, PlatformIO, ArduinoJson 7, Unity (on-device) + bare-g++ host tests. Server: TypeScript (Node 22, strict), vitest, esbuild, Kamal. Both web pages are hand-written HTML/JS with no build step.

**Spec:** `docs/superpowers/specs/2026-09-09-unified-dashboards-airline-ignore-design.md`

---

## File structure

**Create:**

| File | Responsibility |
|---|---|
| `firmware/utils/CodeList.h` | Arduino-free `isPlainOperatorCode()`: which list entries may travel in a query string |
| `firmware/test/test_codelist.cpp` | Host test for it |

**Modify:**

| File | Change |
|---|---|
| `firmware/core/Settings.h` / `.cpp` | `filters.airlineDenyList`; one `readCodeList()` helper for the three code lists |
| `firmware/core/Filters.h` | `airlineDenied()` beside `airlineAllowed()` |
| `firmware/core/FlightDataFetcher.h` / `.cpp` | Apply the deny list in `classifyAndFilter` (pinned exempt) and Flights mode |
| `firmware/adapters/FlightWallServerFetcher.cpp` | `deny_airlines=` / `allow_airlines=` on the flights request |
| `firmware/core/ControlClient.h` / `.cpp` | `clearui` action |
| `firmware/core/WebConfigServer.h` / `.cpp` | Getters for the status fields the check-in mirrors; `operatorIcao` in `/api/flights` |
| `firmware/src/main.cpp` | Apply `clearui`; richer check-in status |
| `firmware/test/test_logic/test_main.cpp` | Deny-list filter and settings round-trip cases |
| `firmware/data/index.html` | Ignore list + search, enrichment cache, live-list ignore button, server cards |
| `tools/webui_stub.mjs` | New settings fields, `?server=` knob, `operatorIcao` on stub flights |
| `server/src/flights.ts` | `deny_airlines` / `allow_airlines` before the cut |
| `server/src/airlines.ts` | `searchAirlines()` |
| `server/src/control.ts` / `controlAuth.ts` | `clearui` |
| `server/src/server.ts` | CORS on browser routes; `/v1/airlines/search` |
| `server/src/tracked/page.ts` | Parity fields, presets, search, `clearui`, richer status |
| `server/test/flights.test.ts`, `airlines.test.ts`, `control.test.ts`, `server.test.ts`, `tracked/page.test.ts` | Coverage for all of the above |
| `README.md`, `server/README.md`, `firmware/README.md`, `HANDOFF.md` | Docs |

---

### Task 1: Firmware — the deny list in Settings and Filters

**Files:**
- Modify: `firmware/core/Settings.h` (struct `AircraftFilters`)
- Modify: `firmware/core/Settings.cpp` (`serialize`, `fromJson`)
- Modify: `firmware/core/Filters.h`
- Test: `firmware/test/test_logic/test_main.cpp`

- [ ] **Step 1: Write the failing Unity tests**

Add after `test_airline_allow`:

```cpp
void test_airline_deny()
{
    std::vector<String> empty;
    TEST_ASSERT_FALSE(Filters::airlineDenied(empty, "EJA", "1I", "NetJets"));

    std::vector<String> deny;
    deny.push_back("eja"); // lower-case on purpose -> case-insensitive match
    deny.push_back("NJE");
    TEST_ASSERT_TRUE(Filters::airlineDenied(deny, "EJA", "", ""));
    TEST_ASSERT_TRUE(Filters::airlineDenied(deny, "", "NJE", ""));
    TEST_ASSERT_FALSE(Filters::airlineDenied(deny, "DAL", "DL", "Delta"));
    // A flight with no operator code at all never matches a listed one.
    TEST_ASSERT_FALSE(Filters::airlineDenied(deny, "", "", ""));
}
```

Extend `test_settings_parse`'s JSON with `"airlineDenyList":[" eja \",\"\",\"NJE\"]` and assert:

```cpp
    TEST_ASSERT_EQUAL_INT(2, (int)g_settings.filters.airlineDenyList.size());
    TEST_ASSERT_TRUE(g_settings.filters.airlineDenyList[0] == "EJA");
    TEST_ASSERT_TRUE(g_settings.filters.airlineDenyList[1] == "NJE");
```

Extend `test_settings_roundtrip` with `g_settings.filters.airlineDenyList.push_back("EJA");` and `TEST_ASSERT_TRUE(tmp.filters.airlineDenyList[0] == "EJA");`. Register `RUN_TEST(test_airline_deny);`.

- [ ] **Step 2: Compile the suite to see it fail**

Run: `cd firmware && pio test -e esp32s3 --without-uploading --without-testing`
Expected: compile error, `airlineDenied` and `airlineDenyList` undeclared.

- [ ] **Step 3: Implement**

`Settings.h`, in `AircraftFilters`:

```cpp
    // If non-empty, HIDE flights whose operator (ICAO/IATA) is in this list.
    // The allow-list says "only these"; this says "everything except these",
    // which is the question a business-jet operator overhead actually raises.
    // A pinned (server-watched) flight is exempt -- see classifyAndFilter.
    std::vector<String> airlineDenyList;
```

`Settings.cpp`: a file-local helper replaces the three copies of the trim/uppercase loop:

```cpp
// Trim, uppercase, drop blanks -- ONE rule for every code list the UI posts
// (tracked flights, the airline allow-list, the airline ignore list), so the
// three cannot drift into accepting different shapes.
static void readCodeList(JsonVariant arr, std::vector<String> &out)
{
    out.clear();
    for (JsonVariant v : arr.as<JsonArray>())
    {
        String s = v.as<String>();
        s.trim();
        s.toUpperCase();
        if (s.length())
            out.push_back(s);
    }
}
```

Serialise `airlineDenyList` beside `airlineAllowList`; parse with `if (filt.containsKey("airlineDenyList")) readCodeList(filt["airlineDenyList"], filters.airlineDenyList);`.

`Filters.h`:

```cpp
    // Empty deny-list means "hide nothing". Otherwise any of the operator codes
    // matching (case-insensitive) hides the flight. Same three fields the
    // allow-list compares, so a code that can let a flight in can keep it out.
    inline bool airlineDenied(const std::vector<String> &denyList,
                              const String &operatorIcao,
                              const String &operatorIata,
                              const String &operatorCode)
    {
        for (const String &c : denyList)
        {
            if (c.length() == 0)
                continue; // never let a blank entry match a blank field
            if (c.equalsIgnoreCase(operatorIcao) ||
                c.equalsIgnoreCase(operatorIata) ||
                c.equalsIgnoreCase(operatorCode))
                return true;
        }
        return false;
    }
```

- [ ] **Step 4: Compile the suite again**

Run: `cd firmware && pio test -e esp32s3 --without-uploading --without-testing`
Expected: builds. (No board attached, so the tests are compile-checked, not executed.)

- [ ] **Step 5: Commit**

```bash
git add firmware/core/Settings.h firmware/core/Settings.cpp firmware/core/Filters.h firmware/test/test_logic/test_main.cpp
git commit -m "feat(filters): an airline ignore list beside the allow-list"
```

---

### Task 2: Firmware — apply it, and tell the server

**Files:**
- Create: `firmware/utils/CodeList.h`, `firmware/test/test_codelist.cpp`
- Modify: `firmware/core/FlightDataFetcher.h:188`, `firmware/core/FlightDataFetcher.cpp` (`classifyAndFilter`, `fetchFlightsMode`)
- Modify: `firmware/adapters/FlightWallServerFetcher.cpp` (URL build)

- [ ] **Step 1: Write the failing host test**

`firmware/test/test_codelist.cpp`:

```cpp
// Host unit tests for utils/CodeList.h -- compile with g++, no hardware.
#ifndef PIO_UNIT_TESTING
#include "../utils/CodeList.h"
#include <cstdio>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    CHECK(isPlainOperatorCode("EJA"));
    CHECK(isPlainOperatorCode("DL"));
    CHECK(isPlainOperatorCode("9W"));
    CHECK(!isPlainOperatorCode("E"));       // too short
    CHECK(!isPlainOperatorCode("EJAX"));    // too long
    CHECK(!isPlainOperatorCode(""));
    CHECK(!isPlainOperatorCode(nullptr));
    CHECK(!isPlainOperatorCode("E&A"));     // would cut the query string
    CHECK(!isPlainOperatorCode("EJ "));     // stray whitespace
    if (failures) { printf("%d FAILED\n", failures); return 1; }
    printf("ALL PASS\n");
    return 0;
}
#endif
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd firmware && ./run_host_tests.sh codelist`
Expected: `FAIL codelist (compile)` -- header missing.

- [ ] **Step 3: Implement the helper**

`firmware/utils/CodeList.h`:

```cpp
#pragma once
// Arduino-free pure helper (host-testable). No String, no Arduino.h.
#include <cctype>
#include <cstddef>

// True for a 2- or 3-character operator code made only of letters and digits --
// the shape both airline lists are meant to hold, and the only shape that can
// travel in a query string without escaping. Anything else stays on the device
// (the local filter compares it case-insensitively and it simply never matches)
// but is never sent to the server, where a stray "&" or "#" would cut the query
// string short and silently drop every parameter after it.
inline bool isPlainOperatorCode(const char *code)
{
    if (!code)
        return false;
    size_t n = 0;
    for (; code[n] != '\0'; ++n)
    {
        if (n >= 3)
            return false;
        if (!std::isalnum((unsigned char)code[n]))
            return false;
    }
    return n >= 2;
}
```

- [ ] **Step 4: Run the host test**

Run: `cd firmware && ./run_host_tests.sh codelist`
Expected: `ok    codelist` / `All 1 host tests passed.`

- [ ] **Step 5: Apply the list in the fetcher**

`FlightDataFetcher.h`, beside `passesAirlineAllowList`: `bool isAirlineDenied(const FlightInfo &info);`

`FlightDataFetcher.cpp`:

```cpp
bool FlightDataFetcher::isAirlineDenied(const FlightInfo &info)
{
    return Filters::airlineDenied(g_settings.filters.airlineDenyList,
                                  info.operator_icao,
                                  info.operator_iata,
                                  info.operator_code);
}
```

In `classifyAndFilter`, after the allow-list check:

```cpp
    // The ignore list. A PINNED flight is exempt for the same reason it is
    // exempt from the general-aviation rule above: somebody asked for that
    // exact flight by name, and "hide NetJets" was said about the traffic
    // overhead, not about the one they are following.
    if (!info.pinned && isAirlineDenied(info))
        return false;
```

In `fetchFlightsMode`, after `if (!passesAirlineAllowList(info)) continue;`: `if (isAirlineDenied(info)) continue;`

- [ ] **Step 6: Pass both lists to the server**

`FlightWallServerFetcher.cpp`, include `"utils/CodeList.h"` and add:

```cpp
// Append `&<key>=A,B,C` for the entries of `list` that are plain operator codes.
// See utils/CodeList.h for why the others are left out. The server normalises
// again on arrival; this only keeps the URL well-formed.
static void appendCodeList(String &url, const char *key, const std::vector<String> &list)
{
    String joined;
    for (const String &c : list)
    {
        if (!isPlainOperatorCode(c.c_str()))
            continue;
        if (joined.length())
            joined += ',';
        joined += c;
    }
    if (joined.length())
        url += String("&") + key + "=" + joined;
}
```

After the `max_alt_ft` line:

```cpp
    // The airline lists too, and for the same reason as the altitude band: the
    // server picks the nearest `max` flights, and a filter applied only after
    // that cut leaves empty slots instead of the next-nearest airliner.
    appendCodeList(url, "deny_airlines", g_settings.filters.airlineDenyList);
    appendCodeList(url, "allow_airlines", g_settings.filters.airlineAllowList);
```

- [ ] **Step 7: Build both envs**

Run: `cd firmware && pio run -e esp32s3 && pio run -e esp32dev`
Expected: both `SUCCESS`.

- [ ] **Step 8: Commit**

```bash
git add firmware/utils/CodeList.h firmware/test/test_codelist.cpp firmware/core/FlightDataFetcher.h firmware/core/FlightDataFetcher.cpp firmware/adapters/FlightWallServerFetcher.cpp
git commit -m "feat(filters): apply the ignore list on every source, and pass both lists to the server"
```

---

### Task 3: Server — honour the lists before the nearest-N cut

**Files:**
- Modify: `server/src/flights.ts`
- Test: `server/test/flights.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('handleFlights: airline allow and deny lists', () => {
  it('deny_airlines drops matching operators BEFORE the nearest-N cut', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([
      ac({ hex: 'a1', callsign: 'EJA123', distanceNm: 2 }),
      ac({ hex: 'a2', callsign: 'DAL456', distanceNm: 5 }),
      ac({ hex: 'a3', callsign: 'NJE789', distanceNm: 8 }),
      ac({ hex: 'a4', callsign: 'UAL111', distanceNm: 12 }),
    ]);
    const res = await handleFlights(
      mkUrl({ lat: LAT, lon: LON, max: '2', deny_airlines: 'eja, NJE' }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { flights: { cs: string }[] };
    // Two slots, and both go to operators that were NOT ignored: the filter
    // runs before the cut, so an ignored jet costs no slot.
    expect(body.flights.map((f) => f.cs)).toEqual(['DAL456', 'UAL111']);
  });

  it('allow_airlines keeps only the listed operators', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([
      ac({ hex: 'a1', callsign: 'EJA123', distanceNm: 2 }),
      ac({ hex: 'a2', callsign: 'DAL456', distanceNm: 5 }),
      ac({ hex: 'a3', callsign: 'UAL111', distanceNm: 12 }),
    ]);
    const res = await handleFlights(
      mkUrl({ lat: LAT, lon: LON, allow_airlines: 'DAL' }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { flights: { cs: string }[] };
    expect(body.flights.map((f) => f.cs)).toEqual(['DAL456']);
  });

  it('matches the marketing IATA code a schedule row supplies, not only the callsign prefix', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([ac({ hex: 'a1', callsign: 'EDV5075', distanceNm: 10 })]);
    const kv = new FakeKV();
    const now = Date.now();
    await seedSchedule(kv, [{
      callsign: null, carrierIata: 'DL', number: '5075',
      origIata: 'CVG', destIata: 'LGA',
      origLat: CVG.lat, origLon: CVG.lon, destLat: LGA.lat, destLon: LGA.lon,
      schedArrEpoch: null, revArrEpoch: null,
    }], now);
    // Endeavor operates it, Delta sells it; "ignore Delta" should cover both.
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON, deny_airlines: 'DL' }), mkEnv(kv), now);
    const body = (await res.json()) as { flights: unknown[] };
    expect(body.flights).toEqual([]);
  });

  it('ignores junk entries rather than rejecting the request', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([ac({ hex: 'a1', callsign: 'EJA123', distanceNm: 2 })]);
    const res = await handleFlights(
      mkUrl({ lat: LAT, lon: LON, deny_airlines: ',, 99 ,&&,eja' }), mkEnv(new FakeKV()), Date.now());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flights: unknown[] };
    expect(body.flights).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd server && npx vitest run test/flights.test.ts -t "allow and deny"`
Expected: 4 failures (lists not honoured).

- [ ] **Step 3: Implement**

`flights.ts`: import `{ carrierIataOf, normaliseCarrierCode, operatorIcaoOf }` from `./carrierCode`, add:

```ts
/**
 * A comma-separated list of operator codes from the query string, as a set.
 *
 * Normalised through the same rule the airline-names page uses, so "eja",
 * " EJA " and "EJA" are one entry and "99" and "&&" are nothing at all --
 * dropped silently rather than failing the request, because the device
 * sends whatever the person typed and a typo in a filter must cost a filter,
 * never the whole wall.
 */
function codeSet(raw: string | null): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const code = normaliseCarrierCode(part);
    if (code) out.add(code);
  }
  return out;
}

/** Does this card's operator appear in `codes`, in either vocabulary? */
function operatorIn(codes: Set<string>, f: Flight): boolean {
  const icao = operatorIcaoOf(f.cs);
  const iata = carrierIataOf(f.flt);
  return (icao !== null && codes.has(icao)) || (iata !== null && codes.has(iata));
}
```

In `handleFlights`, parse `const deny = codeSet(q.get('deny_airlines'));` and `const allow = codeSet(q.get('allow_airlines'));`, then after `enrich()`:

```ts
    if (!f) continue;
    // The device's airline lists, applied BEFORE the nearest-N cut below --
    // the same reason the altitude band is: the device cannot un-pick a
    // flight this server chose, so a filter applied only on the device would
    // leave empty slots where the next-nearest airliner should be. Pinned
    // cards are merged after the cut and are exempt, matching the device.
    if (deny.size > 0 && operatorIn(deny, f)) continue;
    if (allow.size > 0 && !operatorIn(allow, f)) continue;
    pairs.push({ a, f });
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npx vitest run test/flights.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/flights.ts server/test/flights.test.ts
git commit -m "feat(flights): honour the device's airline lists before the nearest-N cut"
```

---

### Task 4: Server — name search, CORS, `clearui`

**Files:**
- Modify: `server/src/airlines.ts`, `server/src/server.ts`, `server/src/control.ts`, `server/src/controlAuth.ts`
- Test: `server/test/airlines.test.ts`, `server/test/server.test.ts`, `server/test/control.test.ts`

- [ ] **Step 1: Failing tests**

`airlines.test.ts`:

```ts
describe('searchAirlines', () => {
  it('finds a carrier by any part of its name, case-insensitively', () => {
    const codes = searchAirlines('netjets').map((h) => h.code);
    expect(codes).toContain('EJA');
    expect(codes).toContain('NJE');
  });

  it('labels a hit with the name the wall would show, not the longest one', () => {
    const eja = searchAirlines('netjets').find((h) => h.code === 'EJA');
    expect(eja?.name).toBe('NetJets');
  });

  it('finds an exact code too, and returns each code once', () => {
    const hits = searchAirlines('dal');
    expect(hits.map((h) => h.code)).toContain('DAL');
    expect(new Set(hits.map((h) => h.code)).size).toBe(hits.length);
  });

  it('answers nothing for a query too short to mean anything', () => {
    expect(searchAirlines('')).toEqual([]);
    expect(searchAirlines('a')).toEqual([]);
  });

  it('caps the result list', () => {
    expect(searchAirlines('air', 5)).toHaveLength(5);
  });
});
```

`server.test.ts` (inside `describe('startServer')`):

```ts
  it('lets a browser on another origin use the tracked and airline routes, and nothing else', async () => {
    running = await startServer({ /* same config literal as the tracked gate test, with controlToken */ });
    const base = `http://127.0.0.1:${running.port}`;
    const pre = await fetch(`${base}/v1/tracked`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    // The refusal itself must be readable cross-origin, or the LAN page cannot
    // tell "wrong password" from "server down".
    const refused = await fetch(`${base}/v1/tracked`);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBe('*');
    const search = await fetch(`${base}/v1/airlines/search?q=netjets`);
    expect(search.status).toBe(200);
    expect(search.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await search.json()) as { ok: boolean; results: { code: string }[] };
    expect(body.results.map((r) => r.code)).toContain('EJA');
    // Control stays same-origin only.
    expect((await fetch(`${base}/v1/control`, { headers: { authorization: 'Bearer flightwall123' } }))
      .headers.get('access-control-allow-origin')).toBeNull();
  });
```

`control.test.ts`: add `'clearui'` to the `actionNeedsAdmin` loop and a case that the ui tier is refused `{action:'clearui'}` while admin queues it.

- [ ] **Step 2: Run to see them fail**

Run: `cd server && npx vitest run test/airlines.test.ts test/server.test.ts test/control.test.ts`

- [ ] **Step 3: Implement**

`airlines.ts`:

```ts
export interface AirlineHit { code: string; name: string }

/**
 * Carriers whose name contains `q`, or whose code is exactly `q`.
 *
 * FOR THE IGNORE LIST. A person looking at a NetJets Citation overhead knows
 * the word "NetJets" and nothing else; the device wants "EJA". Walked in the
 * same precedence airlineName() reads, so each code appears once and is
 * labelled with the name the wall would actually show for it.
 */
export function searchAirlines(q: string, limit = 12): AirlineHit[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const upper = needle.toUpperCase();
  const seen = new Set<string>();
  const hits: AirlineHit[] = [];
  for (const table of [NAMES, DEVICE_CARRIER_NAMES, CARRIER_NAMES]) {
    for (const [code, name] of Object.entries(table)) {
      if (seen.has(code)) continue;
      if (code !== upper && !name.toLowerCase().includes(needle)) continue;
      seen.add(code);
      hits.push({ code, name: airlineName(code) ?? name });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
```

`controlAuth.ts`: `const ADMIN_ACTIONS = new Set(['restart', 'updateui', 'updatefw', 'clearui']);`
`control.ts`: `const ACTIONS = ['restart', 'updateui', 'updatefw', 'clearui'] as const;`

`server.ts`, above `handleRequest`:

```ts
/**
 * Routes a browser on ANOTHER origin may call.
 *
 * The device's own LAN page carries the watched-flights and airline-name cards
 * and drives them against this server straight from the browser -- an
 * http://flightwall.local page may fetch an https:// resource; the
 * mixed-content rule blocks only the other direction. "*" is safe because the
 * credential is a bearer header the page sets on purpose, never a cookie: a
 * hostile site gets no ambient login to borrow, and can only call these with a
 * password it already holds. The control routes are deliberately NOT here.
 */
const BROWSER_ROUTES = ['/v1/tracked', '/v1/airlines'];
const isBrowserRoute = (p: string): boolean =>
  BROWSER_ROUTES.some((r) => p === r || p.startsWith(r + '/'));
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
};
```

At the top of `handleRequest` after `url`:

```ts
  if (isBrowserRoute(url.pathname)) {
    // setHeader, so every writeHead below -- 200, 401, 404 alike -- carries
    // them; Node merges the two. A refusal a browser cannot read is
    // indistinguishable from a dead server.
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (url.pathname === '/v1/airlines/search' && (req.method === 'GET' || req.method === 'HEAD')) {
    // Open, unlike the rest of /v1/airlines: three bundled tables of public
    // carrier names, no state, nothing about anyone. Gating it would mean the
    // LAN page cannot turn "netjets" into "EJA" without the server password.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, results: searchAirlines(url.searchParams.get('q') ?? '') }));
    return;
  }
```

- [ ] **Step 4: Run the tests, typecheck**

Run: `cd server && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src server/test
git commit -m "feat(server): airline name search, CORS for the LAN page, and a clearui action"
```

---

### Task 5: Server page parity

**Files:**
- Modify: `server/src/tracked/page.ts`
- Test: `server/test/tracked/page.test.ts`

- [ ] **Step 1: Failing page tests**

```ts
  it('offers the device-only fields the LAN page always had', () => {
    for (const id of ['f_tracking_trackedFlights', 'f_filters_airlineAllowList', 'f_filters_airlineDenyList', 'f_api_serverUrl']) {
      expect(trackedPage, `${id} missing`).toContain(`id="${id}"`);
    }
  });

  it('collects list fields as arrays, so the device gets what it stores', () => {
    for (const id of ['f_tracking_trackedFlights', 'f_filters_airlineAllowList', 'f_filters_airlineDenyList']) {
      expect(trackedPage).toMatch(new RegExp(`id="${id}"[^>]*data-list`));
    }
    expect(trackedPage).toContain("hasAttribute('data-list')");
  });

  it('warns about the server URL, because a wrong one ends remote control', () => {
    const card = cards(trackedPage).find((c) => c.includes('id="f_api_serverUrl"'))!;
    expect(card).toContain('data-tier="admin"');
    expect(card).toMatch(/ends remote control/i);
  });
```

Update the actions assertion to `['clearui', 'restart', 'updatefw', 'updateui']`.

- [ ] **Step 2: Run to see them fail**

Run: `cd server && npx vitest run test/tracked/page.test.ts`

- [ ] **Step 3: Implement** (all inside the template literal; page JS uses no backticks)

CSS: `input, select, textarea { ... }` (add `textarea` to the existing rule) and `textarea { min-height:64px; resize:vertical; font-family:ui-monospace,Menlo,monospace; }`.

Tracking & filters card, after the mode row:

```html
      <label for="f_tracking_trackedFlights">Flights to track (Flights mode) — flight number, callsign or tail, one per line</label>
      <textarea id="f_tracking_trackedFlights" data-list placeholder="UAL123, N172SP" spellcheck="false" autocapitalize="characters"></textarea>
```

after the hide-cargo checkbox:

```html
      <label for="f_filters_airlineAllowList">Only these airlines (blank = all)</label>
      <input id="f_filters_airlineAllowList" data-list placeholder="UAL, DAL, AAL" autocomplete="off" spellcheck="false" autocapitalize="characters" />
      <label for="f_filters_airlineDenyList">Airlines to ignore</label>
      <input id="f_filters_airlineDenyList" data-list placeholder="EJA, NJE" autocomplete="off" spellcheck="false" autocapitalize="characters" />
      <label for="alFind">Find a code by name</label>
      <input id="alFind" placeholder="netjets" autocomplete="off" />
      <div id="alFindOut" style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px"></div>
      <small class="help">Codes, not names: the 3-letter one from the callsign (<code>EJA</code> — NetJets
        flies as EJA123) or the 2-letter one from a boarding pass. Type a name above to look one up.
        Ignored operators are dropped on every position source, and the server leaves them out of the
        nearest-first cut too, so they cost no slots. A watched flight is always shown, ignored or not.</small>
```

Sources & keys card (admin), before the AeroAPI key:

```html
      <label>FlightWall server URL</label>
      <input id="f_api_serverUrl" placeholder="https://flightwall.example" autocomplete="off" spellcheck="false" />
      <small class="help" style="color:var(--warn)">The wall reaches THIS page through that URL. A wrong value
        ends remote control until someone corrects it on the LAN page.</small>
```

HUB75 card, above the size row:

```html
      <div class="row" style="margin-bottom:6px">
        <div style="flex:0 0 auto"><button class="ghost" type="button" data-panel="64,32,1">64×32</button></div>
        <div style="flex:0 0 auto"><button class="ghost" type="button" data-panel="64,64,1">64×64</button></div>
        <div style="flex:0 0 auto"><button class="ghost" type="button" data-panel="64,64,2">128×64 (Mini)</button></div>
      </div>
```

Flash card: `<div style="flex:0 0 auto"><button class="ghost" data-action="clearui">Use built-in web UI</button></div>`.

JS: in `populate()` after the null check: `if (Array.isArray(v)) v = v.join(el.tagName === 'TEXTAREA' ? '\n' : ', ');`. In `collect()`'s value branch: `else if (el.hasAttribute('data-list')) { v = el.value.split(/[\n,]/).map(function(s){ return s.trim(); }).filter(Boolean); }`. `doAction` gains the clearui prompt. `renderStatus` gains `Web UI` and `Source` rows and a `Server offers` row fed by a `/v1/assets/manifest` fetch in `pollCtl`. New `findAirlines()`, `addIgnored()`, `setPanel()` and the two click delegations (`data-ignore`, `data-panel`).

- [ ] **Step 4: Run the page tests**

Run: `cd server && npx vitest run test/tracked/page.test.ts`
Expected: pass, including the pre-existing invariants (admin fields in admin cards, every field submittable).

- [ ] **Step 5: Commit**

```bash
git add server/src/tracked/page.ts server/test/tracked/page.test.ts
git commit -m "feat(page): every device control on the remote page, minus WiFi"
```

---

### Task 6: Firmware — `clearui`, richer check-in, `operatorIcao`

**Files:**
- Modify: `firmware/core/ControlClient.h`, `firmware/core/ControlClient.cpp`, `firmware/core/WebConfigServer.h`, `firmware/core/WebConfigServer.cpp`, `firmware/src/main.cpp`

- [ ] **Step 1: `clearui`**

`ControlClient.h` Outcome: `bool clearUi = false;`. `ControlClient.cpp`: `else if (action == "clearui") o.clearUi = true;`. `main.cpp`, before the `updateUi` block:

```cpp
    if (o.clearUi)
    {
        // The LAN page's "Use built-in" button, from afar: the escape hatch
        // for a downloaded page that is valid, current, and bad.
        const bool had = AssetUpdater::servingCachedUi();
        AssetUpdater::clearCachedUi();
        Serial.printf("[control] ui cache %s\n", had ? "cleared; serving the built-in page" : "was already the built-in page");
    }
```

- [ ] **Step 2: Check-in status**

`WebConfigServer.h` public getters:

```cpp
    int lightLevel() const { return _lightLevel; }
    bool lightDark() const { return _lightDark; }
    const String &activeSource() const { return _activeSource; }
    bool sourceFallback() const { return _sourceFallback; }
    bool serverStale() const { return _serverStale; }
```

`main.cpp` `controlCheckIn()` doc additions:

```cpp
    doc["uiSource"] = AssetUpdater::servingCachedUi() ? "server" : "builtin";
    doc["uiSha"] = AssetUpdater::cachedUiSha();
    doc["lightLevel"] = g_web.lightLevel();
    doc["lightDark"] = g_web.lightDark();
    doc["activeSource"] = g_web.activeSource();
    doc["sourceFallback"] = g_web.sourceFallback();
    doc["serverStale"] = g_web.serverStale();
```

- [ ] **Step 3: `/api/flights`**

`buildFlightsJson`: `if (f.operator_icao.length()) o["operatorIcao"] = f.operator_icao;`

- [ ] **Step 4: Build**

Run: `cd firmware && pio run -e esp32s3 && pio run -e esp32dev`

- [ ] **Step 5: Commit**

```bash
git add firmware/core/ControlClient.h firmware/core/ControlClient.cpp firmware/core/WebConfigServer.h firmware/core/WebConfigServer.cpp firmware/src/main.cpp
git commit -m "feat(control): a clearui action, and the check-in reports what /api/status does"
```

---

### Task 7: Device page parity

**Files:**
- Modify: `firmware/data/index.html`, `tools/webui_stub.mjs`

- [ ] **Step 1: Make the stub fail first**

Add nothing yet; edit `loadSettings()` to read `s.filters.airlineDenyList` and `s.api.enrichmentCacheSeconds`, then run `node tools/webui_stub.mjs`.
Expected: it refuses to start, naming the two missing fields.

- [ ] **Step 2: Stub**

`SETTINGS.api.enrichmentCacheSeconds = 600`, `SETTINGS.filters.airlineDenyList = []`, a `server` knob (`?server=http://localhost:8787`) that overrides `api.serverUrl`, and `operatorIcao: 'DAL'` on the first stub flight.

- [ ] **Step 3: Page**

Filters section after the allow-list:

```html
    <label>Airlines to ignore (comma separated ICAO/IATA)</label>
    <input id="airlineDenyList" type="text" placeholder="EJA, NJE" />
    <div id="alFindBox" class="hide">
      <label>Find a code by name <span style="color:var(--muted)">(looked up on your FlightWall server)</span></label>
      <input id="alFind" type="text" placeholder="netjets" autocomplete="off" />
      <div id="alFindOut" class="bar" style="margin-top:6px"></div>
    </div>
    <small class="help">Hidden on every position source. Codes, not names: the 3-letter prefix of the callsign (NetJets flies as <b>EJA</b>123) or the 2-letter IATA code. Each flight in the Status list has an <b>ignore</b> button. A flight you are watching from the server is shown regardless.</small>
```

Advanced → Flight list: `<div><label>Enrichment cache (s)</label><input id="enrichmentCacheSeconds" type="number" min="0" /></div>`.

A new card after Tracking:

```html
  <div id="serverCard" class="card hide">
    <h2>FlightWall server</h2>
    <div id="srvLock">
      <small class="help" id="srvLockMsg"></small>
      <label>Server page password</label>
      <input id="srvPw" type="password" autocomplete="current-password" />
      <div class="bar" style="margin-top:8px"><button type="button" onclick="srvUnlock()">Unlock</button></div>
    </div>
    <div id="srvBody" class="hide">
      <div class="bar" style="justify-content:space-between"><span class="pill" id="srvUrlPill"></span><button class="ghost" type="button" onclick="srvLockNow()">Lock</button></div>
      <div class="sec">Watched flights</div>
      <div id="trackedForm">
        <div class="row">
          <div><label>Flight number</label><input id="twNum" type="text" placeholder="BA181" autocapitalize="characters" /></div>
          <div><label>Departure date</label><input id="twDate" type="date" /></div>
          <div><label>From</label><input id="twFrom" type="text" placeholder="JFK" maxlength="3" /></div>
          <div><label>To</label><input id="twTo" type="text" placeholder="LHR" maxlength="3" /></div>
        </div>
        <div class="bar" style="margin-top:8px"><button type="button" onclick="watchFlight()">Watch</button></div>
      </div>
      <div id="trackedBox"></div>
      <small class="help">Pinned to the top of the wall while it is in the air, wherever it is. The date is the one on the boarding pass. Full details on the server page.</small>
      <div id="alNamesBox">
        <div class="sec">Airline names</div>
        <div id="unnamedWrap" class="hide"><small class="help">Showing on the wall with no name — click one to fill it in:</small><div id="unnamed" class="bar" style="margin:6px 0"></div></div>
        <div class="row">
          <div><label>Code</label><input id="alCode" type="text" placeholder="AIZ" maxlength="3" autocapitalize="characters" /></div>
          <div><label>Shows as</label><input id="alName" type="text" placeholder="Arkia" maxlength="24" /></div>
        </div>
        <div class="bar" style="margin-top:8px"><button type="button" onclick="saveAirlineName()">Save</button></div>
        <div id="alList"></div>
      </div>
      <small class="help" id="srvErr" style="color:var(--warn)"></small>
    </div>
  </div>
```

JS: `esc()` also escapes both quote characters (values now land in attributes); `loadSettings` reads the two new fields and calls `toggleServerCards(s.api.serverUrl)`; `collect()` adds `airlineDenyList:lines(...)` and `enrichmentCacheSeconds:+...`; the flight list renders `<button class="ghost" data-ignore="EJA">ignore EJA</button>` when `operatorIcao` is present; new functions `toggleServerCards`, `srvFetch`, `pollServer`, `renderTracked`, `watchFlight`, `untrack`, `loadAirlineNames`, `saveAirlineName`, `delAirlineName`, `srvUnlock`, `srvLockNow`, `findAirlines`, `addIgnored`; one delegated click handler for `data-ignore`, `data-untrack`, `data-alkill`, `data-alpick`.

- [ ] **Step 4: Verify in a browser**

Run the server locally with CORS (`cd server && npm run build && CONTROL_TOKEN=devtoken OPENSKY_CLIENT_ID=x OPENSKY_CLIENT_SECRET=y PORT=8787 npm start`) and the stub (`node tools/webui_stub.mjs 8099`), open `http://localhost:8099/?server=http://localhost:8787`. Expect: the server card appears, asks for the password, accepts `flightwall123`, lists watched flights (empty), adds `BA181` for today, removes it; typing `netjets` in the finder lists `EJA NetJets`; clicking it appends `EJA` to the ignore field; `collect()` in the console shows `filters.airlineDenyList: ["EJA"]` and `api.enrichmentCacheSeconds: 600`.

- [ ] **Step 5: Commit**

```bash
git add firmware/data/index.html tools/webui_stub.mjs
git commit -m "feat(webui): every server control on the LAN page, and an airline ignore list with a name finder"
```

---

### Task 8: Docs

**Files:** `README.md` (Filters line, the parity note), `server/README.md` (control page section: parity, CORS, search, the two query parameters), `firmware/README.md` (REST API list), `HANDOFF.md` (a dated entry).

- [ ] **Step 1: Write them**
- [ ] **Step 2: Commit** — `git commit -m "docs: the two pages now carry the same controls; how the ignore list is applied"`

---

### Task 9: Whole-change verification

- [ ] `cd server && npm test && npm run typecheck && npm run build`
- [ ] `cd firmware && ./run_host_tests.sh && pio run -e esp32s3 && pio run -e esp32dev && pio test -e esp32s3 --without-uploading --without-testing`
- [ ] Both pages in a browser (Task 7 step 4, and the server page against the local server after a faked check-in that carries `settings`).
- [ ] `git status` clean; `git log --oneline main..HEAD` lists the commits above.

---

## Ship (asked once, after verification)

Merge to `main`, `cd server && kamal deploy`, build + `tools/sign_firmware.sh` + `tools/publish_firmware.sh --update` and `--ui-update`, confirm the wall's next check-in reports the new `fwVersion`, push `main`.
