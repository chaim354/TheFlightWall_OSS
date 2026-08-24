#pragma once
// Arduino-free pure helper (host-testable). No String, no Arduino.h, no globals.
#include <cstdint>

/**
 * What loop() should do about fetching this pass.
 *
 * forceFetch and discardFlights are genuinely independent, not two names for
 * the same bit: a wake after a LONG dark spell forces a fetch AND discards
 * what's held, while a wake after a BRIEF one forces a fetch but keeps it.
 */
struct IdleDecision
{
    // Skip the fetch entirely this pass. The caller also stores this same
    // value as next pass's `wasSuppressed` argument -- "suppress now" and
    // "was suppressed last time" are one bit, not two. An earlier draft kept
    // a separate `nowSuppressed` field for this; it was assigned identically
    // to suppressFetch on every path (both default false, both set true only
    // together, nowhere else), so it was dropped rather than left on a
    // 4-field API as a misuse hazard -- a later edit could change one and not
    // the other and nothing here would catch it.
    bool suppressFetch = false;
    bool forceFetch = false;     // wake: fetch now, do not wait for the interval
    bool discardFlights = false; // wake: what we hold is too old to show
};

/**
 * Decide whether to fetch, given the RESOLVED panel brightness.
 *
 * `effectiveBrightness` is applyBrightness()'s output, not the raw setting: it
 * already folds in the night schedule, the ambient sensor, a manual button ramp
 * and the off toggle, so zero means "dark for any reason" and this helper needs
 * to know none of those reasons.
 *
 * It takes `int`, not `uint8_t`, on purpose. main.cpp's g_appliedBrightness --
 * the value a caller here actually holds -- is an int that is -1 before the
 * first applyBrightness() call and after every re-init path (setManualBrightness,
 * the off-toggle button, a settings change): "not applied yet", not "dark". A
 * caller that clamped that sentinel to 0 before calling in would have it read
 * as dark, which both suppresses this pass AND arms the wake path -- so the
 * very next pass would force-fetch and DISCARD whatever flights were already
 * on screen, over a sentinel that never measured the panel at all. Taking
 * `int` instead lets any negative value fall through the `== 0` check
 * untouched and be treated as lit, the same resolution main.cpp already
 * applies to this exact sentinel elsewhere
 * (`g_appliedBrightness >= 0 ? ... : g_settings.brightness`). This also
 * removes a narrowing cast from every call site, closing a second trap: a
 * `uint8_t` parameter silently wraps 256 down to 0 and reads a too-bright
 * value as dark. The two ways to guess this wrong are not equally bad --
 * guessing "lit" when it was actually dark costs one wasted fetch next pass;
 * guessing "dark" when it was actually lit suppresses a visible panel and
 * then discards good flights -- so ties resolve to lit.
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
 * The three time arguments are `uint32_t`, the width millis() actually
 * returns on-device, specifically so `nowMs - lastGoodFetchMs` wraps
 * correctly at the ~49.7-day rollover with no cast needed here. ServerBackoff.h
 * handles the identical rollover the OPPOSITE way: it takes an
 * already-subtracted `elapsedMs` and never calls or subtracts against
 * millis() itself, leaving that arithmetic -- and its wrap-safety -- entirely
 * to the caller (see its header comment). Doing the subtraction in here
 * instead is what makes the wrap directly host-testable as part of this
 * function's own suite, rather than only provable by hand-simulating the
 * caller the way test_serverbackoff.cpp has to. See the wrap case in
 * test_idlewhendark.cpp.
 */
inline IdleDecision decideIdle(int effectiveBrightness,
                               bool wasSuppressed,
                               uint32_t lastGoodFetchMs,
                               uint32_t nowMs,
                               uint32_t staleWindowMs)
{
    IdleDecision d;

    if (effectiveBrightness == 0)
    {
        d.suppressFetch = true;
        return d;
    }

    if (wasSuppressed)
    {
        // Just woke.
        d.forceFetch = true;
        // lastGoodFetchMs == 0 means "no good fetch ever", which is not the same
        // as "ancient" -- there is nothing on screen to discard.
        d.discardFlights = (lastGoodFetchMs != 0) && ((nowMs - lastGoodFetchMs) > staleWindowMs);
    }

    return d;
}
