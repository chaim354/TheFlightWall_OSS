#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h.
#include <cstdint>

// How long to wait before the next fetch, given the configured interval and the
// two pressure signals loop() tracks.
//
// WHY max() AND NOT if/else. These were two ladders selected by precedence --
// `if (failures > 0) ... else if (empties >= N) ...` -- so ANY non-zero failure
// count suppressed the empty ladder entirely. That is not a hypothetical
// ordering nit:
//
//   * g_consecutiveFailures is cleared ONLY by a fetch that returns flights, so
//     one transient failure followed by an unbounded run of successful-but-EMPTY
//     fetches leaves it at 1 forever. Nothing else resets it.
//   * At the 30s default, failures==1 gives 60s. The empty ladder at two or more
//     empties demands 120s. Precedence handed back the 60s.
//
// So a stale counter HALVED the anti-rate-limit interval -- the precise
// protection the empty ladder was written to provide, defeated by a signal that
// had gone quiet. The empty ladder's own comment even asserted the precondition
// the representation did not enforce: that an empty-reply rate limit "never sets
// ok=false, so g_consecutiveFailures stays 0".
//
// Taking the max makes both counters pressure signals that can only LENGTHEN the
// interval. A stale one can no longer shorten below what a live one demands, and
// no ordering between them has to be got right.

/** Consecutive empty fetches before the empty ladder engages. */
static const uint8_t kEmptyConfirmCycles = 2;

/** Doubling ladder: base << min(steps, maxShift), clamped to capMs. */
inline unsigned long backoffLadder(unsigned long baseMs, uint8_t steps, uint8_t maxShift, unsigned long capMs)
{
    const uint8_t shift = steps > maxShift ? maxShift : steps;

    // A configured interval already longer than the cap is left ALONE, not
    // clamped down to it. The old code clamped unconditionally, so with
    // fetchIntervalSeconds above 300 a failure made the device poll MORE often
    // than configured -- e.g. 400s base, one failure, 800s backoff, clamped to
    // the 300s cap. A backoff that shortens the interval is the one thing this
    // must never do.
    if (baseMs >= capMs)
        return baseMs;

    const unsigned long backoff = baseMs << shift;

    // Detect wrap. `baseMs << 4` exceeds 32 bits for a configured interval above
    // ~268,435s, and Settings applies no upper bound (the web UI carries only an
    // HTML min="5" hint). Far-fetched, but an overflow yields a SHORT interval,
    // which is the direction that matters.
    if (shift > 0 && (backoff >> shift) != baseMs)
        return capMs;

    return backoff > capMs ? capMs : backoff;
}

/**
 * Exponential backoff on consecutive failures: 2x per failure, capped at 5 min.
 * Protects the OpenSky daily credit budget when the API or WiFi is down.
 */
inline unsigned long failureLadder(unsigned long baseMs, uint8_t failures)
{
    if (failures == 0)
        return baseMs;
    return backoffLadder(baseMs, failures, 4, 300000UL);
}

/**
 * Sustained empties get their own, gentler ladder. This covers the case the
 * failure ladder cannot see: a source rate-limiting us purely with well-formed
 * empty replies never sets ok=false, so the failure count stays 0 and we would
 * otherwise keep polling at the base rate indefinitely -- precisely the
 * behaviour that sustains a rate limit.
 *
 * Capped at 2 minutes rather than 5, because unlike a failure an empty result
 * may simply be a quiet sky, and a 5-minute hole there would delay the first
 * real arrival for no reason. Self-correcting either way: fewer requests let the
 * limit lapse, flights come back, the counter resets.
 *
 * Engages on the SECOND consecutive empty, not the third. FR24's limiting
 * alternates rather than clustering: measured over 13 minutes at a 50% throttle
 * rate, the longest run of consecutive empties was two, so a ladder that waited
 * for three stayed dormant through the entire window it was written for.
 */
inline unsigned long emptyLadder(unsigned long baseMs, uint8_t empties)
{
    if (empties < kEmptyConfirmCycles)
        return baseMs;
    const uint8_t extra = (uint8_t)(empties - kEmptyConfirmCycles + 1);
    return backoffLadder(baseMs, extra, 2, 120000UL);
}

/** The interval to actually use: whichever pressure signal demands more. */
inline unsigned long fetchIntervalMs(unsigned long baseMs, uint8_t failures, uint8_t empties)
{
    const unsigned long a = failureLadder(baseMs, failures);
    const unsigned long b = emptyLadder(baseMs, empties);
    return a > b ? a : b;
}
