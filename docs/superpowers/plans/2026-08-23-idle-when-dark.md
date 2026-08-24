# Idle When Dark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the device fetching while the panel is at effective brightness 0, and stop the server refreshing its schedule table between 00:00 and 06:00.

**Architecture:** Two independent changes. On the device, a pure header-only helper decides whether to fetch and whether a wake needs to discard stale flights; `loop()` calls it after `applyBrightness()` has resolved the effective brightness. On the server, `startServer`'s fixed 2h `setInterval` is replaced by a 5-minute checker driving a pure `shouldRefresh()` predicate, so a refresh lands within 5 minutes of quiet hours ending rather than up to 2 hours later.

**Tech Stack:** C++11 (arduino-esp32 2.0.17, PlatformIO), bare-g++ host tests; TypeScript (Node 22, vitest).

**Spec:** `docs/superpowers/specs/2026-08-23-idle-when-dark-design.md`

---

## File Structure

**Device**
- Create `firmware/utils/IdleWhenDark.h` — pure decision helper. No Arduino, no globals. Sits beside `utils/FetchCadence.h`, which it mirrors in style.
- Create `firmware/test/test_idlewhendark.cpp` — host test. Picked up automatically by `run_host_tests.sh`, which globs `test/test_*.cpp`.
- Modify `firmware/src/main.cpp` — call the helper in `loop()`.

**Server**
- Create `server/src/schedule/quietHours.ts` — pure predicates, no I/O, no Date.now().
- Create `server/test/quietHours.test.ts`.
- Modify `server/src/server.ts` — config fields, defaults, and the refresh loop.

Boundaries: both new modules are pure functions over explicit arguments. Nothing reads a clock or a global, so both are fully testable off-target — which matters on the firmware side, where there is no `native` PlatformIO env and on-device tests only run on a flash.

---

## Task 1: Device decision helper

**Files:**
- Create: `firmware/utils/IdleWhenDark.h`
- Test: `firmware/test/test_idlewhendark.cpp`

- [ ] **Step 1: Write the failing test**

Create `firmware/test/test_idlewhendark.cpp`:

```cpp
// Host unit tests for IdleWhenDark.h — compile with g++, no hardware.
//
// Guarded so a `pio test` build doesn't pull this into the on-device binary;
// see the comment in platformio.ini. Under the bare-g++ workflow
// PIO_UNIT_TESTING is never defined, so the guard is a no-op there.
#ifndef PIO_UNIT_TESTING
#include "../utils/IdleWhenDark.h"
#include <cstdio>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    const unsigned long STALE = 180000UL; // 6 x 30s, the existing stale window

    // --- while lit, never suppress and never discard ---
    {
        IdleDecision d = decideIdle(20, false, 1000UL, 5000UL, STALE);
        CHECK(!d.suppressFetch);
        CHECK(!d.discardFlights);
        CHECK(!d.forceFetch);
        CHECK(!d.nowSuppressed);
    }

    // --- brightness 0 suppresses, whatever the cause ---
    {
        IdleDecision d = decideIdle(0, false, 1000UL, 5000UL, STALE);
        CHECK(d.suppressFetch);
        CHECK(d.nowSuppressed);
        CHECK(!d.discardFlights); // going dark does not clear the screen
        CHECK(!d.forceFetch);
    }

    // --- staying dark stays suppressed ---
    {
        IdleDecision d = decideIdle(0, true, 1000UL, 900000UL, STALE);
        CHECK(d.suppressFetch);
        CHECK(d.nowSuppressed);
        CHECK(!d.forceFetch);
    }

    // --- waking after a LONG dark period: discard and refetch ---
    {
        // last good fetch at t=1000, now t=900000 -> 899s old, well past 180s
        IdleDecision d = decideIdle(20, true, 1000UL, 900000UL, STALE);
        CHECK(!d.suppressFetch);
        CHECK(d.forceFetch);
        CHECK(d.discardFlights);
        CHECK(!d.nowSuppressed);
    }

    // --- waking after a BRIEF dark period: refetch but keep the flights ---
    {
        // last good fetch at t=1000, now t=60000 -> 59s old, inside 180s
        IdleDecision d = decideIdle(20, true, 1000UL, 60000UL, STALE);
        CHECK(!d.suppressFetch);
        CHECK(d.forceFetch);
        CHECK(!d.discardFlights);
    }

    // --- never fetched at all: nothing to discard, but do fetch ---
    {
        IdleDecision d = decideIdle(20, true, 0UL, 900000UL, STALE);
        CHECK(d.forceFetch);
        CHECK(!d.discardFlights); // 0 means "no good fetch yet", not "ancient"
    }

    // --- millis() wrap must not look like a stale set ---
    {
        // lastGood near the 32-bit ceiling, now just past the wrap
        const unsigned long lastGood = 0xFFFFF000UL;
        const unsigned long now = 0x00001000UL; // wrapped
        IdleDecision d = decideIdle(20, true, lastGood, now, STALE);
        CHECK(d.forceFetch);
        CHECK(!d.discardFlights); // unsigned subtraction wraps correctly: ~8s old
    }

    if (failures == 0) { printf("test_idlewhendark: ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif // PIO_UNIT_TESTING
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd firmware && g++ -std=c++17 -Wall -Wextra test/test_idlewhendark.cpp -o /tmp/t_iwd`

Expected: FAIL — `fatal error: '../utils/IdleWhenDark.h' file not found`

- [ ] **Step 3: Write the minimal implementation**

Create `firmware/utils/IdleWhenDark.h`:

```cpp
#pragma once
// Arduino-free pure helper (host-testable). No String, no Arduino.h, no globals.
#include <cstdint>

/**
 * What loop() should do about fetching this pass.
 *
 * Separate flags rather than one enum because they are genuinely independent:
 * a wake both forces a fetch AND may need to discard, while going dark does
 * neither.
 */
struct IdleDecision
{
    bool suppressFetch = false;  // skip the fetch entirely this pass
    bool forceFetch = false;     // wake: fetch now, do not wait for the interval
    bool discardFlights = false; // wake: what we hold is too old to show
    bool nowSuppressed = false;  // the caller stores this as the next wasSuppressed
};

/**
 * Decide whether to fetch, given the RESOLVED panel brightness.
 *
 * `effectiveBrightness` is applyBrightness()'s output, not the raw setting: it
 * already folds in the night schedule, the ambient sensor, a manual button ramp
 * and the off toggle, so zero means "dark for any reason" and this helper needs
 * to know none of those reasons.
 *
 * WHY DISCARD ON WAKE. Suppression can span a whole night. The flights held in
 * memory would then be hours old, and rendering them for the second before the
 * first fetch lands would put aircraft on the wall that landed before dawn --
 * the "plausible-looking wrong value" this codebase treats as a silent failure.
 * The staleness rule is the one the failure path already uses, passed in rather
 * than duplicated.
 *
 * NOTE: suppression is NOT failure. The caller must not touch its backoff
 * counters on a suppressed pass, or the first fetch after a dark night would
 * start at the 300s cap.
 *
 * All time arguments are millis() values; subtraction is unsigned so the 49.7-day
 * wrap is handled without a special case.
 */
inline IdleDecision decideIdle(uint8_t effectiveBrightness,
                               bool wasSuppressed,
                               unsigned long lastGoodFetchMs,
                               unsigned long nowMs,
                               unsigned long staleWindowMs)
{
    IdleDecision d;

    if (effectiveBrightness == 0)
    {
        d.suppressFetch = true;
        d.nowSuppressed = true;
        return d;
    }

    if (wasSuppressed)
    {
        // Just woke.
        d.forceFetch = true;
        // lastGoodFetchMs == 0 means "no good fetch ever", which is not the same
        // as "ancient" -- there is nothing on screen to discard.
        //
        // Truncate to uint32_t before subtracting. On the device `unsigned long`
        // is already 32 bits so this is a no-op, but the HOST test binary builds
        // it as 64 bits, where a millis()-wrapped pair does not wrap at all and
        // subtracts to a huge (wrong) elapsed time instead of the small one it
        // actually represents mod 2^32. Same seam test_serverbackoff.cpp already
        // documents; pinning the width makes both builds agree.
        const uint32_t elapsedMs = (uint32_t)nowMs - (uint32_t)lastGoodFetchMs;
        d.discardFlights = (lastGoodFetchMs != 0) && (elapsedMs > staleWindowMs);
    }

    return d;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd firmware && g++ -std=c++17 -Wall -Wextra test/test_idlewhendark.cpp -o /tmp/t_iwd && /tmp/t_iwd`

Expected: `test_idlewhendark: ALL PASS`

- [ ] **Step 5: Confirm the runner picks it up automatically**

Run: `cd firmware && ./run_host_tests.sh`

Expected: `All 10 host tests passed.` (was 9 — the runner globs `test/test_*.cpp`, so no list needs editing.)

- [ ] **Step 6: Commit**

```bash
git add firmware/utils/IdleWhenDark.h firmware/test/test_idlewhendark.cpp
git commit -m "feat(fetch): pure helper deciding whether to fetch while the panel is dark"
```

---

## Task 2: Wire the helper into loop()

**Files:**
- Modify: `firmware/src/main.cpp` (include near the other `utils/` includes; gate at the fetch block, currently lines 706-726)

- [ ] **Step 1: Add the include**

In `firmware/src/main.cpp`, immediately after the existing line:

```cpp
#include "utils/FetchCadence.h"
```

add:

```cpp
#include "utils/IdleWhenDark.h"
```

- [ ] **Step 2: Add the suppression-state global**

In `firmware/src/main.cpp`, immediately after the existing line:

```cpp
static unsigned long g_lastGoodFetchMs = 0;    // for the stale-data cutoff
```

add:

```cpp
// Whether the previous loop pass suppressed fetching because the panel was dark.
// Only used to detect the WAKE edge; see utils/IdleWhenDark.h.
static bool g_fetchSuppressed = false;
```

- [ ] **Step 3: Insert the gate**

In `firmware/src/main.cpp`, find this block (it currently begins at line 706):

```cpp
    // In AP setup mode we only serve the web UI (no network for fetching).
    if (g_apMode || WiFi.status() != WL_CONNECTED)
    {
        delay(5);
        return;
    }
```

Immediately AFTER that block's closing brace, insert:

```cpp
    // Don't fetch into a dark panel. g_appliedBrightness is applyBrightness()'s
    // resolved output -- base setting, night schedule, ambient sensor, button
    // ramp and the off toggle all folded in -- so this covers every reason the
    // panel is off. The night schedule is where the volume is: ~960 fetches per
    // dark night, each a TLS handshake on a link the 2026-08-23 RF work showed
    // to be fragile.
    //
    // This MUST sit after applyBrightness() earlier in loop(), or it reads a
    // stale brightness on the very pass where it changes -- the wake pass.
    {
        const uint32_t staleMs = (uint32_t)g_settings.fetchIntervalSeconds * 1000UL * 6UL;
        // Pass g_appliedBrightness straight through. It is an int whose -1 means
        // "not applied yet", and decideIdle treats any negative as LIT -- do NOT
        // clamp it to 0 here. Clamping to 0 would mark the pass suppressed, and
        // the NEXT pass would then force a fetch AND discard the held flights,
        // blanking the wall from a momentary sentinel. main.cpp:355 resolves the
        // same sentinel the same way, to a lit value.
        const IdleDecision idle = decideIdle(
            g_appliedBrightness, g_fetchSuppressed,
            (uint32_t)g_lastGoodFetchMs, (uint32_t)millis(), staleMs);
        // suppressFetch IS the next pass's wasSuppressed -- one bit, not two.
        g_fetchSuppressed = idle.suppressFetch;

        if (idle.discardFlights && !g_lastFlights.empty())
        {
            // Woke to a set older than the stale window. Clearing shows the
            // loading screen for a second rather than aircraft that have landed.
            Serial.println("Woke with stale flights; clearing and refetching");
            g_lastFlights.clear();
            g_display.markFlightsUpdated();
            g_display.displayFlights(g_lastFlights);
            g_web.setServerStale(false);
        }
        if (idle.forceFetch)
            g_lastFetchMs = 0; // fetch on this pass rather than waiting out the interval

        if (idle.suppressFetch)
        {
            // Deliberately does NOT touch g_consecutiveFailures/g_consecutiveEmpty:
            // suppression is not failure, and polluting them would start the first
            // fetch after a dark night at the 300s backoff cap.
            delay(5);
            return;
        }
    }
```

- [ ] **Step 4: Build both envs**

Run: `cd firmware && pio run -e esp32s3 && pio run -e esp32dev`

Expected: `SUCCESS` for both.

- [ ] **Step 5: Verify the on-device suite still compiles**

Run: `cd firmware && pio test -e esp32s3 --without-uploading --without-testing`

Expected: `esp32s3:test_logic [PASSED]`

- [ ] **Step 6: Verify by inspection that suppression cannot pollute the backoff counters**

The host test in Task 1 cannot cover this — `decideIdle` is pure and has no
access to the counters, so only the WIRING can get it wrong.

Run: `cd firmware && grep -n "g_consecutiveFailures\|g_consecutiveEmpty\|doFetchAndRender()" src/main.cpp`

Confirm that in `loop()`, every line that mutates `g_consecutiveFailures` or
`g_consecutiveEmpty` lives inside `doFetchAndRender()`, and that the
`if (idle.suppressFetch) { ... return; }` block added in Step 3 sits ABOVE the
call to `doFetchAndRender()`. If a suppressed pass could reach that call, the
first fetch after a dark night would start at the 300s backoff cap.

- [ ] **Step 7: Commit**

```bash
git add firmware/src/main.cpp
git commit -m "feat(fetch): stop fetching while the panel is dark"
```

---

## Task 3: Server quiet-hours predicates

**Files:**
- Create: `server/src/schedule/quietHours.ts`
- Test: `server/test/quietHours.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/quietHours.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseQuietHours, inQuietHours, shouldRefresh } from '../src/schedule/quietHours';

describe('parseQuietHours', () => {
  it('parses a plain window', () => {
    expect(parseQuietHours('0-6')).toEqual({ startHour: 0, endHour: 6 });
  });

  it('treats empty or "off" as disabled', () => {
    expect(parseQuietHours('')).toBeNull();
    expect(parseQuietHours('off')).toBeNull();
    expect(parseQuietHours(undefined)).toBeNull();
  });

  it('rejects malformed input rather than guessing', () => {
    // A typo must not silently become a window that suppresses refreshes all day.
    for (const bad of ['6', '6-', '-6', 'a-b', '0-24', '-1-6', '0-6-8']) {
      expect(parseQuietHours(bad)).toBeNull();
    }
  });
});

describe('inQuietHours', () => {
  const w = { startHour: 0, endHour: 6 };

  it('is true inside the window and false outside', () => {
    expect(inQuietHours(0, w)).toBe(true);
    expect(inQuietHours(3, w)).toBe(true);
    expect(inQuietHours(5, w)).toBe(true);
    expect(inQuietHours(6, w)).toBe(false); // end is exclusive
    expect(inQuietHours(12, w)).toBe(false);
    expect(inQuietHours(23, w)).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    const wrap = { startHour: 23, endHour: 7 };
    expect(inQuietHours(23, wrap)).toBe(true);
    expect(inQuietHours(0, wrap)).toBe(true);
    expect(inQuietHours(6, wrap)).toBe(true);
    expect(inQuietHours(7, wrap)).toBe(false);
    expect(inQuietHours(12, wrap)).toBe(false);
  });
});

describe('shouldRefresh', () => {
  const TWO_H = 2 * 60 * 60 * 1000;

  it('never refreshes inside quiet hours', () => {
    expect(shouldRefresh({ nowMs: 100_000_000, lastRefreshMs: 0, intervalMs: TWO_H, quiet: true, wasQuiet: true })).toBe(false);
    expect(shouldRefresh({ nowMs: 100_000_000, lastRefreshMs: 0, intervalMs: TWO_H, quiet: true, wasQuiet: false })).toBe(false);
  });

  it('refreshes IMMEDIATELY on leaving quiet hours, whatever the interval says', () => {
    // This is the whole point: setInterval has arbitrary phase, so waiting for
    // the next tick could leave the morning cold for nearly two hours.
    expect(shouldRefresh({ nowMs: 1000, lastRefreshMs: 999, intervalMs: TWO_H, quiet: false, wasQuiet: true })).toBe(true);
  });

  it('otherwise refreshes on the interval', () => {
    expect(shouldRefresh({ nowMs: TWO_H, lastRefreshMs: 0, intervalMs: TWO_H, quiet: false, wasQuiet: false })).toBe(true);
    expect(shouldRefresh({ nowMs: TWO_H - 1, lastRefreshMs: 0, intervalMs: TWO_H, quiet: false, wasQuiet: false })).toBe(false);
  });

  it('refreshes when nothing has been refreshed yet', () => {
    expect(shouldRefresh({ nowMs: 0, lastRefreshMs: null, intervalMs: TWO_H, quiet: false, wasQuiet: false })).toBe(true);
  });

  it('does not refresh at boot if boot lands inside quiet hours', () => {
    expect(shouldRefresh({ nowMs: 0, lastRefreshMs: null, intervalMs: TWO_H, quiet: true, wasQuiet: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run test/quietHours.test.ts`

Expected: FAIL — `Failed to load url ../src/schedule/quietHours`

- [ ] **Step 3: Write the minimal implementation**

Create `server/src/schedule/quietHours.ts`:

```ts
/**
 * Quiet hours for the schedule refresh.
 *
 * The device stops fetching while its panel is dark (see
 * firmware/utils/IdleWhenDark.h), which stops adsb.lol position fetching for
 * free -- those happen per /v1/flights request. The AeroDataBox schedule
 * refresh is a timer and does not follow, so it gets its own window.
 *
 * WHY THE WINDOW MUST END BEFORE THE PANEL WAKES. server.ts's refresh window is
 * +/-6h centred on BUILD time and is spent by the end of each cycle. A table
 * built at 23:00 covers 17:00-05:00, so a panel waking at 07:00 against it has
 * no rows for morning departures. Ending quiet hours at 06:00 lands a refresh
 * while it is still dark, centred on the morning.
 *
 * That relationship -- not the two literal times -- is the invariant: quiet
 * hours must end at least one refresh interval before the panel wakes.
 */
export interface QuietWindow {
  /** Inclusive local hour the window starts. */
  startHour: number;
  /** Exclusive local hour the window ends. */
  endHour: number;
}

/**
 * Parse a "START-END" hour window, e.g. "0-6". Returns null when disabled or
 * malformed.
 *
 * Malformed input returns null (disabled) rather than a guess: a typo that
 * silently became an all-day window would stop the schedule refreshing
 * entirely, and the failure would look like an upstream outage.
 */
export function parseQuietHours(raw: string | undefined): QuietWindow | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === '' || s === 'off') return null;

  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;

  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return null;
  if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) return null;
  if (startHour === endHour) return null; // a zero-width window is a typo, not a request

  return { startHour, endHour };
}

/** Is `hour` (0-23, local) inside the window? Handles windows that wrap midnight. */
export function inQuietHours(hour: number, w: QuietWindow): boolean {
  if (w.startHour < w.endHour) return hour >= w.startHour && hour < w.endHour;
  return hour >= w.startHour || hour < w.endHour; // wraps midnight
}

export interface RefreshCheck {
  nowMs: number;
  /** null when nothing has been refreshed yet this process. */
  lastRefreshMs: number | null;
  intervalMs: number;
  quiet: boolean;
  wasQuiet: boolean;
}

/**
 * Should the schedule refresh run on this check?
 *
 * Called on a short cadence (minutes), not on the refresh interval, so that
 * leaving quiet hours triggers a refresh promptly. setInterval has arbitrary
 * phase -- keying off it alone could leave the table cold for nearly a full
 * interval after the window ends.
 */
export function shouldRefresh(c: RefreshCheck): boolean {
  if (c.quiet) return false;
  if (c.wasQuiet) return true; // just left the window: refresh now
  if (c.lastRefreshMs === null) return true;
  return c.nowMs - c.lastRefreshMs >= c.intervalMs;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run test/quietHours.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add server/src/schedule/quietHours.ts server/test/quietHours.test.ts
git commit -m "feat(schedule): quiet-hours and refresh-decision predicates"
```

---

## Task 4: Wire quiet hours into the server

**Files:**
- Modify: `server/src/server.ts` (`ServerConfig` at line 9, `configFromEnv` around line 93, the refresh loop at lines 210-219)

- [ ] **Step 1: Add the import**

At the top of `server/src/server.ts`, alongside the other `./schedule/` imports, add:

```ts
import { parseQuietHours, inQuietHours, shouldRefresh, type QuietWindow } from './schedule/quietHours';
```

- [ ] **Step 2: Add the config fields**

In `server/src/server.ts`, inside `interface ServerConfig`, immediately after the `refreshIntervalMs: number;` field and its comment block, add:

```ts
  /**
   * Hours during which the schedule refresh is skipped, as "START-END" local
   * hours, or null to always refresh.
   *
   * Defaults to 00:00-06:00: the panel's night schedule ends at 07:00, and this
   * must end at least one refresh interval BEFORE that so a refresh lands while
   * it is still dark and the table is centred on the morning. See
   * src/schedule/quietHours.ts.
   */
  quietHours: QuietWindow | null;
  /** IANA zone the quiet-hours window is interpreted in. */
  quietHoursTimeZone: string;
```

- [ ] **Step 3: Add the defaults**

In `server/src/server.ts`, immediately above `configFromEnv`, add:

```ts
// 00:00-06:00. All four boards are NYC-area, so local time is America/New_York.
const DEFAULT_QUIET_HOURS = '0-6';
const DEFAULT_QUIET_TZ = 'America/New_York';
```

Then inside `configFromEnv`'s returned object, after the `refreshIntervalMs` entry, add:

```ts
    quietHours: parseQuietHours(env.REFRESH_QUIET_HOURS ?? DEFAULT_QUIET_HOURS),
    quietHoursTimeZone: env.REFRESH_QUIET_TZ ?? DEFAULT_QUIET_TZ,
```

- [ ] **Step 4: Replace the refresh timer**

In `server/src/server.ts`, find:

```ts
  void runBoth(); // once at boot
  const timer = setInterval(() => void runBoth(), config.refreshIntervalMs);
```

Replace those two lines with:

```ts
  // Checked every 5 minutes rather than every refreshIntervalMs. setInterval has
  // arbitrary phase, so keying the refresh off it alone would mean the first run
  // after quiet hours end could be nearly a full interval late -- leaving the
  // table centred on the previous evening exactly when the panel wakes.
  const REFRESH_CHECK_MS = 5 * 60 * 1000;
  let lastRefreshMs: number | null = null;
  let wasQuiet = false;

  const localHour = (): number =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: config.quietHoursTimeZone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date()),
    ) % 24;

  const refreshTick = async (): Promise<void> => {
    const quiet = config.quietHours !== null && inQuietHours(localHour(), config.quietHours);
    const go = shouldRefresh({
      nowMs: Date.now(),
      lastRefreshMs,
      intervalMs: config.refreshIntervalMs,
      quiet,
      wasQuiet,
    });
    if (quiet && !wasQuiet) {
      // Logged, not silent: a refresh that stops happening must say so, or it is
      // indistinguishable from an upstream outage.
      console.log(`schedule: entering quiet hours (${config.quietHours!.startHour}-${config.quietHours!.endHour} ${config.quietHoursTimeZone}); refresh paused`);
    }
    wasQuiet = quiet;
    if (!go) return;
    lastRefreshMs = Date.now();
    await runBoth();
  };

  void refreshTick(); // once at boot
  const timer = setInterval(() => void refreshTick(), REFRESH_CHECK_MS);
```

- [ ] **Step 5: Typecheck and run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`

Expected: no tsc output; all tests pass (324 existing + the new quietHours cases).

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(schedule): pause the refresh between 00:00 and 06:00"
```

---

## Task 5: Document the knobs

**Files:**
- Modify: `server/README.md`
- Modify: `server/config/deploy.yml`

- [ ] **Step 1: Document the env vars in the server README**

In `server/README.md`, in the section listing environment variables, add:

```markdown
- `REFRESH_QUIET_HOURS` — local-hour window during which the AeroDataBox
  schedule refresh is skipped, as `START-END` (end exclusive). Default `0-6`.
  Set to `off` to always refresh. Malformed values are treated as `off`.
- `REFRESH_QUIET_TZ` — IANA zone the window is read in. Default
  `America/New_York`.

**The window must end at least one refresh interval before your panel wakes.**
The refresh window is ±6h centred on build time, so a table built at 23:00
covers 17:00–05:00 — a panel waking at 07:00 against it has no rows for morning
departures. The `0-6` default assumes a panel whose night schedule ends at
07:00; change both together.
```

- [ ] **Step 2: Note it in the deploy config**

In `server/config/deploy.yml`, inside the `env: clear:` block, after the `BOARDS` entry, add:

```yaml
    # Skip the AeroDataBox refresh 00:00-06:00 local. Must end at least one
    # refresh interval before the panel wakes (its night schedule ends 07:00) --
    # see server/README.md. Set to "off" to always refresh.
    REFRESH_QUIET_HOURS: "0-6"
    REFRESH_QUIET_TZ: "America/New_York"
```

- [ ] **Step 3: Commit**

```bash
git add server/README.md server/config/deploy.yml
git commit -m "docs(schedule): document the quiet-hours knobs and their constraint"
```

---

## Task 6: Full verification

- [ ] **Step 1: Firmware**

Run:
```bash
cd firmware && pio run -e esp32dev && pio run -e esp32s3 \
  && pio test -e esp32s3 --without-uploading --without-testing \
  && ./run_host_tests.sh
```

Expected: both builds `SUCCESS`, `test_logic [PASSED]`, `All 10 host tests passed.`

- [ ] **Step 2: Server**

Run: `cd server && npx tsc --noEmit && npx vitest run`

Expected: no tsc output; all tests pass.

- [ ] **Step 3: Tools (regression check)**

Run: `python3 -m unittest discover -s tools -p 'test_*.py'`

Expected: `OK`

- [ ] **Step 4: Confirm the tree is clean**

Run: `git status --short`

Expected: no output.

---

## Deployment notes

Not part of the plan's tasks — these are actions for the maintainer.

- The firmware change needs `pio run -e esp32s3 -t upload`. It does **not** touch
  `data/index.html`, so no `uploadfs` and settings survive.
- The server change needs a `kamal deploy` from `server/`.
- To verify the device change on hardware: set `display.brightness` to 0 via
  `/api/settings`, confirm `/api/flights` stops changing and the serial log goes
  quiet, then set it back and confirm a fetch happens immediately rather than
  after up to 30s.
- To verify the server change: check the log for the `entering quiet hours` line
  at 00:00 local, and a refresh within 5 minutes of 06:00.
