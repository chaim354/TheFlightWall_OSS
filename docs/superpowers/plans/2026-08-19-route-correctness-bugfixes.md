# Route Correctness Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three independent defects that make the wall display wrong or missing routes, before any of the larger server work begins.

**Architecture:** Tasks 1–2 extract the decision into a pure, Arduino-free helper in `utils/` (the existing `CallsignUtils.h` pattern), host-tested with g++, then wire that helper into the adapter — no behavior depends on hardware, so those tasks are verifiable in seconds. Task 3 does not: the guarding condition (`origin.length() || dest.length()`) is too thin to justify a header plus test file, and the overlay matrix it guards is built on Arduino's `String`/`FlightInfo`, which can't be lifted out cheaply. Task 3 is instead verified by full firmware compilation on both targets plus the existing host suite, which exercises regressions but does not cover this exact code path.

**Tech Stack:** C++17, PlatformIO (`esp32dev` / `esp32s3`), header-only pure helpers, hand-rolled `CHECK` host tests compiled directly with g++.

---

## Scope

This is **plan 1 of 3** for [the server-mediated route + ETA design](../specs/2026-08-19-server-mediated-route-eta-design.md).

- **Plan 1 (this one) — bug fixes.** Independent of everything else. Ships alone.
- **Plan 2 — Cloudflare Worker.** Blocked on two AeroDataBox questions (the FIDS
  credit tier, and whether FIDS rows carry the ICAO callsign). The second can
  delete the entire composite-key join design, so writing that plan first would
  be wasted work.
- **Plan 3 — firmware adapters.** Depends on the Plan 2 contract, not its code.

The three bugs here are real today on the current `adsbdb`/`hexdb` path and are
worth fixing regardless of whether the server work ever happens.

## Background

Measured against Flightradar24 on live NYC traffic, the current enrichment path
returns the wrong destination for 68% of flights, and 52% of all flights get a
*confidently wrong* city. Root cause is that a callsign does not determine a
route — that is what the server work addresses. These three bugs are separate,
narrower defects layered on top of it.

## File Structure

| File | Responsibility |
|---|---|
| `firmware/utils/RouteUtils.h` | **new.** Pure parsing of a hexdb rotation string into one leg. No Arduino types. |
| `firmware/test/test_route.cpp` | **new.** Host tests for `RouteUtils.h`. |
| `firmware/utils/CallsignUtils.h` | **modify.** Add `enrichmentCacheKey()` next to the existing `cacheActionFor()` cache-policy helper. |
| `firmware/test/test_parsers.cpp` | **modify.** Add `enrichmentCacheKey()` cases. |
| `firmware/adapters/AdsbdbFetcher.cpp` | **modify.** Use `parseFirstLeg()` instead of the inline first/last split. |
| `firmware/core/FlightDataFetcher.cpp` | **modify.** Cache key, and the inline-enrichment overlay. |
| `docs/data-sources.md` | **modify.** Correct advice that currently makes bug 2 worse. |
| `HANDOFF.md` | **modify.** Add `route` to the documented host-test loop. |

## Verification used by every task

Host tests (fast, no hardware):

```bash
cd firmware && for t in parsers classify lru buttons clock route; do g++ -std=c++17 test/test_$t.cpp -o /tmp/t_$t && /tmp/t_$t && echo "PASS $t"; done
```

Firmware still compiles:

```bash
cd firmware && pio run -e esp32dev
```

---

### Task 1: Stop hexdb round-trips rendering as "LAX → LAX"

hexdb returns a whole **rotation**, not one leg — e.g. `KLAX-KDFW-KLAX`. The
current code takes the first segment and the **last** segment, so a round trip
resolves to origin == destination and the wall displays `LAX → LAX`. Measured:
27% of sampled routes were multi-leg, so this is common, not exotic.

Without the aircraft's position we cannot know which leg it is currently flying,
so take the **first** leg: it is always a real leg, and never degenerate.

**Files:**
- Create: `firmware/utils/RouteUtils.h`
- Create: `firmware/test/test_route.cpp`
- Modify: `firmware/adapters/AdsbdbFetcher.cpp:105-108`

- [x] **Step 1: Write the failing test**

Create `firmware/test/test_route.cpp`:

```cpp
// Host unit tests for RouteUtils.h — compile with g++, no hardware.
#include "../utils/RouteUtils.h"
#include <cstdio>
#include <cstring>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    char o[8], d[8];

    // Simple two-segment route.
    CHECK(parseFirstLeg("EGLL-KJFK", o, sizeof(o), d, sizeof(d)));
    CHECK(strcmp(o, "EGLL") == 0);
    CHECK(strcmp(d, "KJFK") == 0);

    // Rotation: take the FIRST leg, not first-and-last. This is the bug.
    CHECK(parseFirstLeg("KLAX-KDFW-KLAX", o, sizeof(o), d, sizeof(d)));
    CHECK(strcmp(o, "KLAX") == 0);
    CHECK(strcmp(d, "KDFW") == 0);   // NOT KLAX

    CHECK(parseFirstLeg("KDTW-KPHL-KDTW", o, sizeof(o), d, sizeof(d)));
    CHECK(strcmp(o, "KDTW") == 0);
    CHECK(strcmp(d, "KPHL") == 0);

    // Surrounding whitespace is trimmed.
    CHECK(parseFirstLeg("  KJFK - KLAX  ", o, sizeof(o), d, sizeof(d)));
    CHECK(strcmp(o, "KJFK") == 0);
    CHECK(strcmp(d, "KLAX") == 0);

    // Degenerate and malformed inputs are rejected, not guessed at.
    CHECK(!parseFirstLeg("KJFK-KJFK", o, sizeof(o), d, sizeof(d)));  // same both ends
    CHECK(!parseFirstLeg("KJFK", o, sizeof(o), d, sizeof(d)));       // one segment
    CHECK(!parseFirstLeg("", o, sizeof(o), d, sizeof(d)));
    CHECK(!parseFirstLeg(nullptr, o, sizeof(o), d, sizeof(d)));
    CHECK(!parseFirstLeg("-KJFK", o, sizeof(o), d, sizeof(d)));      // empty origin
    CHECK(!parseFirstLeg("KJFK-", o, sizeof(o), d, sizeof(d)));      // empty dest

    // A segment longer than the caller's buffer is rejected rather than truncated,
    // because a truncated ICAO code is a different, real airport.
    char tiny[3];
    CHECK(!parseFirstLeg("EGLL-KJFK", tiny, sizeof(tiny), d, sizeof(d)));

    // On failure the outputs are cleared, so a caller that ignores the return
    // value cannot read a stale code from a previous call.
    strcpy(o, "XXXX");
    CHECK(!parseFirstLeg("KJFK", o, sizeof(o), d, sizeof(d)));
    CHECK(o[0] == '\0');

    if (failures == 0) printf("test_route: ALL PASS\n");
    return failures ? 1 : 0;
}
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd firmware && g++ -std=c++17 test/test_route.cpp -o /tmp/t_route
```

Expected: FAIL to compile — `utils/RouteUtils.h: No such file or directory`.

- [x] **Step 3: Write minimal implementation**

Create `firmware/utils/RouteUtils.h`:

```cpp
#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h.
#include <cstddef>

// hexdb's /route/icao/ returns a whole ROTATION, not a single leg:
// "KLAX-KDFW-KLAX" is LAX->DFW->LAX. The original code took the first segment and
// the LAST segment, which renders that round trip as "LAX -> LAX" on the wall.
// 27% of sampled routes are multi-leg, so this was common rather than exotic.
//
// We take the FIRST leg. Without the aircraft's position there is no way to know
// which leg it is currently flying, and the first leg is at least always a real
// one. Callers that DO have a position should select the leg themselves.
//
// Writes NUL-terminated codes into outOrigin/outDest (caps include the NUL) and
// returns true. On any failure both outputs are set to "" and it returns false —
// a segment that does not fit is rejected rather than truncated, because a
// truncated ICAO code names a different, real airport.
inline bool parseFirstLeg(const char *route,
                          char *outOrigin, size_t originCap,
                          char *outDest, size_t destCap)
{
    if (outOrigin && originCap) outOrigin[0] = '\0';
    if (outDest && destCap) outDest[0] = '\0';
    if (!route || !outOrigin || !outDest || originCap == 0 || destCap == 0)
        return false;

    auto isSpace = [](char c) { return c == ' ' || c == '\t'; };

    // Copy route[from,to) into out, trimming spaces. False if empty or too long.
    auto emit = [&](size_t from, size_t to, char *out, size_t cap) {
        while (from < to && isSpace(route[from])) from++;
        while (to > from && isSpace(route[to - 1])) to--;
        const size_t n = to - from;
        if (n == 0 || n + 1 > cap)
            return false;
        for (size_t i = 0; i < n; ++i)
            out[i] = route[from + i];
        out[n] = '\0';
        return true;
    };

    size_t len = 0;
    while (route[len] != '\0') len++;

    // First separator ends segment 1; second (or end of string) ends segment 2.
    size_t d1 = 0;
    while (d1 < len && route[d1] != '-') d1++;
    if (d1 == len)
        return false; // no separator: a single segment is not a leg

    size_t d2 = d1 + 1;
    while (d2 < len && route[d2] != '-') d2++;

    if (!emit(0, d1, outOrigin, originCap) || !emit(d1 + 1, d2, outDest, destCap))
    {
        outOrigin[0] = '\0';
        outDest[0] = '\0';
        return false;
    }

    // A leg that starts and ends at the same airport is not a leg. This is exactly
    // what the old first-and-last split produced for every round trip.
    size_t i = 0;
    while (outOrigin[i] != '\0' && outOrigin[i] == outDest[i]) i++;
    if (outOrigin[i] == '\0' && outDest[i] == '\0')
    {
        outOrigin[0] = '\0';
        outDest[0] = '\0';
        return false;
    }
    return true;
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
cd firmware && g++ -std=c++17 test/test_route.cpp -o /tmp/t_route && /tmp/t_route
```

Expected: `test_route: ALL PASS`, exit 0.

- [x] **Step 5: Wire it into the adapter**

In `firmware/adapters/AdsbdbFetcher.cpp`, add the include below the existing one at the top of the file:

```cpp
#include "adapters/AdsbdbFetcher.h"
#include "utils/RouteUtils.h"
```

Then replace these lines (currently `AdsbdbFetcher.cpp:105-108`):

```cpp
    String route = doc["route"] | "";
    int dash = route.indexOf('-');
    if (dash < 0)
        return false;
    String origin = route.substring(0, dash);
    String dest = route.substring(route.lastIndexOf('-') + 1); // last leg if multi-stop
    origin.trim();
    dest.trim();
```

with:

```cpp
    String route = doc["route"] | "";
    // hexdb returns a whole rotation ("KLAX-KDFW-KLAX"); take the first leg. Taking
    // first-and-last rendered every round trip as "LAX -> LAX". See RouteUtils.h.
    char originBuf[8], destBuf[8];
    if (!parseFirstLeg(route.c_str(), originBuf, sizeof(originBuf), destBuf, sizeof(destBuf)))
        return false;
    String origin(originBuf);
    String dest(destBuf);
```

- [x] **Step 6: Verify the firmware still builds**

```bash
cd firmware && pio run -e esp32dev
```

Expected: `SUCCESS`.

- [x] **Step 7: Commit**

```bash
git add firmware/utils/RouteUtils.h firmware/test/test_route.cpp firmware/adapters/AdsbdbFetcher.cpp
git commit -m "fix(enrich): take the first hexdb leg, not first-and-last

hexdb returns a whole rotation, so KLAX-KDFW-KLAX resolved to origin ==
destination and the wall displayed 'LAX -> LAX'. 27% of sampled routes
are multi-leg. Take the first leg, which is always a real one, and
reject degenerate legs outright."
```

---

### Task 2: Stop the enrichment cache serving a stale leg's route

`FlightDataFetcher.cpp:198` keys the enrichment cache on ICAO24 — the airframe.
But the **route belongs to the leg, not the aircraft**. A regional jet flies five
legs a day; keyed by airframe it keeps its first leg's route for the whole TTL.

The callsign changes with the leg, so it is the correct key and invalidates
naturally. ICAO24 remains the fallback for a state vector with no callsign.

**Files:**
- Modify: `firmware/utils/CallsignUtils.h` (append)
- Modify: `firmware/test/test_parsers.cpp`
- Modify: `firmware/core/FlightDataFetcher.cpp:197-198`
- Modify: `docs/data-sources.md:74`

- [x] **Step 1: Write the failing test**

In `firmware/test/test_parsers.cpp`, add these lines immediately before the
final `if (failures == 0)` line:

```cpp
    // Enrichment cache key: the callsign identifies the LEG and so must win over
    // the airframe. ICAO24 is only a fallback when there is no callsign.
    CHECK(strcmp(enrichmentCacheKey("EDV5075", "a1b2c3"), "EDV5075") == 0);
    CHECK(strcmp(enrichmentCacheKey("", "a1b2c3"), "a1b2c3") == 0);
    CHECK(strcmp(enrichmentCacheKey(nullptr, "a1b2c3"), "a1b2c3") == 0);
    CHECK(strcmp(enrichmentCacheKey("EDV5075", ""), "EDV5075") == 0);
    CHECK(strcmp(enrichmentCacheKey("", ""), "") == 0);
    CHECK(strcmp(enrichmentCacheKey(nullptr, nullptr), "") == 0);
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd firmware && g++ -std=c++17 test/test_parsers.cpp -o /tmp/t_parsers
```

Expected: FAIL to compile — `'enrichmentCacheKey' was not declared in this scope`.

- [x] **Step 3: Write minimal implementation**

Append to `firmware/utils/CallsignUtils.h`, after `cacheActionFor`:

```cpp
// Enrichment cache key. The ROUTE belongs to the flight LEG, not to the airframe:
// a regional jet flies several legs a day, so keying on ICAO24 served the first
// leg's route until the TTL expired — and the TTL is user-configurable up to
// hours. The callsign changes with the leg, so it invalidates naturally. ICAO24
// stays as the fallback for the rare state vector with no callsign.
//
// Returns a pointer into one of the arguments; it does not copy.
inline const char *enrichmentCacheKey(const char *callsign, const char *icao24)
{
    if (callsign && callsign[0] != '\0')
        return callsign;
    return (icao24 && icao24[0] != '\0') ? icao24 : "";
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
cd firmware && g++ -std=c++17 test/test_parsers.cpp -o /tmp/t_parsers && /tmp/t_parsers
```

Expected: exit 0, no `FAIL` lines.

- [x] **Step 5: Wire it into the orchestrator**

In `firmware/core/FlightDataFetcher.cpp`, replace lines 197-198:

```cpp
        // Cache key prefers the stable ICAO24, falling back to callsign.
        const String key = s.icao24.length() ? s.icao24 : s.callsign;
```

with:

```cpp
        // Key on the CALLSIGN, not the airframe: the route belongs to the leg, and
        // an aircraft flies several legs a day. See enrichmentCacheKey().
        const String key = enrichmentCacheKey(s.callsign.c_str(), s.icao24.c_str());
```

`CallsignUtils.h` is already included by `FlightDataFetcher.h`, so no new include
is needed.

- [x] **Step 6: Correct the documentation that makes this worse**

In `docs/data-sources.md`, replace line 74:

```
mid-flight, so you can raise this substantially to cut request volume.
```

with:

```
mid-flight, so you can raise this moderately to cut request volume — but not
without limit. The cache is keyed by callsign, and an aircraft changes callsign
between legs, so a long TTL mainly costs you freshness on aircraft that loiter.
(Before 2026-08 the cache was keyed by the airframe, and a long TTL would pin a
regional jet to its first leg's route for the whole day.)
```

- [x] **Step 7: Verify the firmware still builds**

```bash
cd firmware && pio run -e esp32dev
```

Expected: `SUCCESS`.

- [x] **Step 8: Commit**

```bash
git add firmware/utils/CallsignUtils.h firmware/test/test_parsers.cpp firmware/core/FlightDataFetcher.cpp docs/data-sources.md
git commit -m "fix(enrich): key the enrichment cache by leg, not by airframe

The route belongs to the flight leg, but the cache was keyed on ICAO24,
so a regional jet flying five legs a day kept its first leg's route for
the whole TTL. The callsign changes with the leg and invalidates
naturally. Also corrects data-sources.md, which advised raising the TTL
substantially on the grounds that routes do not change mid-flight --
true mid-flight, false across legs."
```

---

### Task 3: Stop partial inline enrichment suppressing the route lookup

`StateVector::has_inline_enrichment` is set when the position feed supplied
*any* of route, type, or airline. `FlightDataFetcher.cpp:200` then skips the
network lookup entirely. So a feed that carried only the **aircraft type** — with
no route — permanently suppresses the route lookup, and the flight never gets a
route at all.

Two changes are needed together:

1. Gate the skip on the **route** specifically.
2. Apply the inline fields as an **overlay after** the lookup. `getEnriched()`
   assigns `out = entry.info` wholesale on a cache hit, so inline fields written
   before the call would be discarded.

**Files:**
- Modify: `firmware/adapters/FlightRadar24Fetcher.cpp:236-237`
- Modify: `firmware/core/FlightDataFetcher.cpp:200-218`

- [x] **Step 1: Narrow the flag to mean "the feed carried a route"**

In `firmware/adapters/FlightRadar24Fetcher.cpp`, replace lines 236-237:

```cpp
        s.has_inline_enrichment =
            s.origin_iata.length() || s.dest_iata.length() || s.aircraft_type.length();
```

with:

```cpp
        // ROUTE only. This flag decides whether to SKIP the per-flight enrichment
        // lookup, and only the route justifies skipping it — a feed that supplied
        // just the aircraft type used to suppress the route lookup forever, so the
        // flight never got a route at all. Type and airline still ride along; they
        // are applied as an overlay in fetchAreaMode regardless of this flag.
        s.has_inline_enrichment = s.origin_iata.length() || s.dest_iata.length();
```

- [x] **Step 2: Make the consumer overlay inline fields instead of branching**

In `firmware/core/FlightDataFetcher.cpp`, replace lines 200-218 — the whole
`if (s.has_inline_enrichment) { ... } else { ... }` block — with:

```cpp
        // Skip the per-flight network lookup ONLY when the feed carried the route;
        // that is the expensive thing we are avoiding. Best-effort: once the budget
        // is spent this serves cache-only, so the card still renders (callsign +
        // logo below) just without a route.
        if (!s.has_inline_enrichment)
            getEnriched(key, s.callsign, s.icao24, info, withinEnrichBudget());

        // Overlay whatever the position source carried inline (e.g. FlightRadar24
        // ships route, type and operator in the same feed). Applied AFTER the
        // lookup on purpose: getEnriched() assigns `info` wholesale on a cache hit,
        // so anything written before the call would be thrown away. The feed
        // identifies the operator by ICAO code only; applyLocalIdentity below turns
        // that into a display name from the on-device table.
        if (s.origin_iata.length())
            info.origin.code_iata = s.origin_iata;
        if (s.dest_iata.length())
            info.destination.code_iata = s.dest_iata;
        if (s.aircraft_type.length())
            info.aircraft_code = s.aircraft_type;
        if (s.airline_icao.length())
            info.operator_icao = s.airline_icao;
```

- [x] **Step 3: Update the StateVector field comment to match**

In `firmware/models/StateVector.h`, replace line 31:

```cpp
    bool has_inline_enrichment = false;
```

with:

```cpp
    // True only when the feed supplied a ROUTE. It gates skipping the per-flight
    // enrichment lookup, and only a route justifies that. Type/airline that arrive
    // inline are consumed regardless of this flag.
    bool has_inline_enrichment = false;
```

- [x] **Step 4: Verify both environments build**

```bash
cd firmware && pio run -e esp32dev && pio run -e esp32s3
```

Expected: `SUCCESS` for both.

- [x] **Step 5: Run the full host test suite**

```bash
cd firmware && for t in parsers classify lru buttons clock route; do g++ -std=c++17 test/test_$t.cpp -o /tmp/t_$t && /tmp/t_$t && echo "PASS $t"; done
```

Expected: `PASS` for all six.

- [x] **Step 6: Commit**

```bash
git add firmware/adapters/FlightRadar24Fetcher.cpp firmware/core/FlightDataFetcher.cpp firmware/models/StateVector.h
git commit -m "fix(enrich): partial inline data no longer suppresses the route lookup

has_inline_enrichment was set when the feed supplied ANY of route, type
or airline, and the consumer then skipped enrichment entirely -- so a
flight whose feed carried only the aircraft type never got a route.

Narrow the flag to mean 'the feed carried a route', and apply inline
fields as an overlay AFTER the lookup rather than in an either/or branch,
since getEnriched() assigns the FlightInfo wholesale on a cache hit."
```

---

### Task 4: Add the new host test to the documented test loop

`HANDOFF.md` lists the host-test command in two places. Both enumerate the
suites explicitly, so a new suite that is not added there will silently never run.

**Files:**
- Modify: `HANDOFF.md:23` and `HANDOFF.md:222`

- [x] **Step 1: Update both occurrences**

Replace, on line 23:

```
`cd firmware && for t in parsers classify lru buttons clock; do g++ -std=c++17 test/test_$t.cpp -o /tmp/t && /tmp/t; done`
```

with:

```
`cd firmware && for t in parsers classify lru buttons clock route; do g++ -std=c++17 test/test_$t.cpp -o /tmp/t && /tmp/t; done`
```

Replace, on line 222:

```
Host tests: `g++ -std=c++17 test/test_{parsers,classify,lru,buttons,clock}.cpp -o /tmp/t && /tmp/t`.
```

with:

```
Host tests: `g++ -std=c++17 test/test_{parsers,classify,lru,buttons,clock,route}.cpp -o /tmp/t && /tmp/t`.
```

- [x] **Step 2: Verify the documented loop actually runs**

```bash
cd firmware && for t in parsers classify lru buttons clock route; do g++ -std=c++17 test/test_$t.cpp -o /tmp/t_$t && /tmp/t_$t && echo "PASS $t"; done
```

Expected: `PASS` for all six suites.

- [x] **Step 3: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: add test_route to the host test loop"
```

---

## Done when

- [x] All six host suites pass.
- [x] `pio run -e esp32dev` and `pio run -e esp32s3` both SUCCESS.
- [x] `docs/data-sources.md` no longer advises raising the enrichment TTL without limit.
- [ ] Device smoke test: Area mode still renders routes with the FR24 source
      selected (Task 3 touches that path directly) — not yet run.

**Not verified by this plan:** none of this is exercised on real hardware. The
changes are confined to pure parsing, a cache key, and field assignment, all
covered by host tests — but a device smoke test before merging is still worth
doing, particularly that Area mode still renders routes with the FR24 source
selected (Task 3 touches that path directly).
