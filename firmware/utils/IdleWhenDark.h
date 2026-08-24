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
 * All time arguments are millis() values. `unsigned long` is the right type for
 * them -- it matches millis()'s return type and g_lastGoodFetchMs's declared
 * type in main.cpp -- but it is only 32 bits on the actual device. On a 64-bit
 * host (this file's own test binary included) `unsigned long` is 64 bits, so a
 * plain `nowMs - lastGoodFetchMs` would NOT reproduce the device's 49.7-day
 * wrap: two values that are only adjacent mod 2^32 would instead subtract to a
 * huge, wrong elapsed time, and a genuine wake-from-a-brief-blackout would
 * misread as "ancient" and wrongly discard good flights. See decideIdle's
 * uint32_t cast below, and ServerBackoff.h, which hits this identical seam.
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
        // The cast to uint32_t before subtracting is load-bearing, not
        // decorative. millis() wraps every ~49.7 days in the 32-bit space it
        // actually runs in on-device, and unsigned subtraction only self-heals
        // across that wrap when it is performed in THAT width. Doing the
        // subtraction in `unsigned long` works today because that is 32 bits on
        // the ESP32 target -- but this same header also builds as a 64-bit host
        // test binary (see run_host_tests.sh), where `unsigned long` is 64 bits
        // and the wrap this is meant to survive would not occur at all; the
        // stale-looking pair of timestamps would just subtract to a huge
        // (wrong) elapsed time instead of the small one they actually represent
        // mod 2^32. Truncating both operands to uint32_t first makes the
        // arithmetic match the device's width unconditionally, on either build.
        const uint32_t elapsedMs = (uint32_t)nowMs - (uint32_t)lastGoodFetchMs;
        d.discardFlights = (lastGoodFetchMs != 0) && (elapsedMs > staleWindowMs);
    }

    return d;
}
