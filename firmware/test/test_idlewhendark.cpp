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

    // --- brightness 1 is LIT, not dark: pins the "== 0" boundary ---
    //
    // Mutation-testing found this unguarded: mutating the check to "<= 1"
    // survives the suite above because it only ever exercises 0 and 20.
    // Brightness 1 is a real, reachable state -- the ambient sensor's
    // lightDimBrightness defaults to 3, and a manual button ramp can land
    // lower still -- so treating it as dark would wrongly suppress fetching
    // on a panel that is actually visible.
    {
        IdleDecision d = decideIdle(1, false, 1000UL, 5000UL, STALE);
        CHECK(!d.suppressFetch);
        CHECK(!d.discardFlights);
        CHECK(!d.forceFetch);
        CHECK(!d.nowSuppressed);
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

    // --- staleness boundary: exactly STALE old is NOT "older than" ---
    //
    // Mutation-testing found this unguarded: mutating ">" to ">=" on the
    // discardFlights line survives the suite above because no existing case
    // lands exactly on the boundary (899s and 59s both miss it). "Older
    // than" is the correct reading of the staleness rule, so equal must
    // still keep the held flights -- only strictly-greater may discard them.
    {
        // last good fetch at t=1000, now t=181000 -> elapsed is exactly
        // 180000ms, equal to STALE.
        IdleDecision d = decideIdle(20, true, 1000UL, 181000UL, STALE);
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
