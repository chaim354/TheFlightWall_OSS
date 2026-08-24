// Host unit tests for IdleWhenDark.h — compile with g++, no hardware.
//
// Guarded so a `pio test` build doesn't pull this into the on-device binary;
// see the comment in platformio.ini. Under the bare-g++ workflow
// PIO_UNIT_TESTING is never defined, so the guard is a no-op there.
#ifndef PIO_UNIT_TESTING
#include "../utils/IdleWhenDark.h"
#include <cstdint>
#include <cstdio>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    const uint32_t STALE = 180000UL; // 6 x 30s, the existing stale window

    // Every block below checks all three flags, even when most are the
    // "obviously false" default -- a subset previously went unchecked, and
    // that is exactly where two boundary mutants (brightness ==0 vs <=1, and
    // staleness > vs >=) survived undetected. Checking everything everywhere
    // is cheap here and removes that blind spot for the next mutation too.

    // --- while lit, never suppress and never discard ---
    {
        IdleDecision d = decideIdle(20, false, 1000UL, 5000UL, STALE);
        CHECK(!d.suppressFetch);
        CHECK(!d.forceFetch);
        CHECK(!d.discardFlights);
    }

    // --- brightness 0 suppresses, whatever the cause ---
    {
        IdleDecision d = decideIdle(0, false, 1000UL, 5000UL, STALE);
        CHECK(d.suppressFetch);
        CHECK(!d.forceFetch);
        CHECK(!d.discardFlights); // going dark does not clear the screen
    }

    // --- brightness 1 is LIT, not dark: pins the "== 0" boundary ---
    //
    // Mutation-testing found this unguarded: mutating the check to "<= 1"
    // survives the suite above because it only ever exercises 0 and 20. 1 is
    // not an incidental value here -- BrightnessLadder.h deliberately bottoms
    // its ramp out at 1, never 0, precisely so a dimmed-all-the-way panel
    // still reads as visibly on ("'off' is a separate button action");
    // treating 1 as dark would defeat that design and wrongly suppress
    // fetching on a panel the ladder was built to keep showing.
    {
        IdleDecision d = decideIdle(1, false, 1000UL, 5000UL, STALE);
        CHECK(!d.suppressFetch);
        CHECK(!d.forceFetch);
        CHECK(!d.discardFlights);
    }

    // --- negative brightness (the "not applied yet" sentinel) is LIT too ---
    //
    // main.cpp's g_appliedBrightness is -1 before the first applyBrightness()
    // call and after every re-init path -- it is not a brightness sample at
    // all. A caller that clamped it to 0 before calling in would read it as
    // dark, which both suppresses this pass AND arms the wake path, so the
    // very next pass would force-fetch and discard whatever flights were
    // already held, over a sentinel that never measured the panel. Any
    // negative value must fall through untouched and behave exactly like any
    // other lit value.
    {
        IdleDecision d = decideIdle(-1, false, 1000UL, 5000UL, STALE);
        CHECK(!d.suppressFetch);
        CHECK(!d.forceFetch);
        CHECK(!d.discardFlights);
    }

    // --- staying dark stays suppressed ---
    {
        IdleDecision d = decideIdle(0, true, 1000UL, 900000UL, STALE);
        CHECK(d.suppressFetch);
        CHECK(!d.forceFetch);
        CHECK(!d.discardFlights);
    }

    // --- waking after a LONG dark period: discard and refetch ---
    {
        // last good fetch at t=1000, now t=900000 -> 899s old, well past 180s
        IdleDecision d = decideIdle(20, true, 1000UL, 900000UL, STALE);
        CHECK(!d.suppressFetch);
        CHECK(d.forceFetch);
        CHECK(d.discardFlights);
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
        CHECK(!d.suppressFetch);
        CHECK(d.forceFetch);
        CHECK(!d.discardFlights);
    }

    // --- never fetched at all: nothing to discard, but do fetch ---
    {
        IdleDecision d = decideIdle(20, true, 0UL, 900000UL, STALE);
        CHECK(!d.suppressFetch);
        CHECK(d.forceFetch);
        CHECK(!d.discardFlights); // 0 means "no good fetch yet", not "ancient"
    }

    // --- millis() wrap must not look like a stale set ---
    {
        // lastGood near the 32-bit ceiling, now just past the wrap. Both are
        // uint32_t directly -- decideIdle's own parameter width -- so the
        // wrap happens in exactly the arithmetic the function performs, no
        // separate cast to reason about here.
        const uint32_t lastGood = 0xFFFFF000UL;
        const uint32_t now = 0x00001000UL; // wrapped
        IdleDecision d = decideIdle(20, true, lastGood, now, STALE);
        CHECK(!d.suppressFetch);
        CHECK(d.forceFetch);
        CHECK(!d.discardFlights); // unsigned subtraction wraps correctly: ~8s old
    }

    if (failures == 0) { printf("test_idlewhendark: ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif // PIO_UNIT_TESTING
