#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h.
#include <cstdint>

// Escalating retry backoff for the FlightWall-server call specifically (see
// FlightDataFetcher::fetchServerMode). Unlike OpenSky/FR24/adsb.lol, this
// source has a working fallback (adsb.lol) sitting right behind it --
// FlightWallServerFetcher's shortened per-call timeouts (4s handshake, 4s
// read; see its secureClient()) are the other half of this fix, bounding the
// cost of any ONE failed attempt. This half stops a server that has been down
// for a while from paying even that smaller cost on every single 30s cycle.
//
// Schedule, chosen against the default fetchIntervalSeconds=30s
// (core/Settings.h):
//   Base  30s   -- exactly one skipped fetch cycle, so a single transient
//                  failure costs one retry delay, not an immediate re-probe.
//   Grows x2 per additional consecutive failure.
//   Cap   300s  -- reached after 4 failures (30 -> 60 -> 120 -> 240 -> capped
//                  at 300), so a real outage settles into "try roughly once
//                  every 5 minutes" within about 4 fetch cycles (~2 minutes).
//                  At the 30s default that is 9 skipped cycles for every 1
//                  real attempt once capped -- "almost nothing per cycle" --
//                  while still recovering within single-digit minutes of the
//                  server coming back: the cap bounds the WAIT, not the
//                  attempt count, so the next attempt after the cap is always
//                  a real one, never a permanent give-up.
constexpr unsigned long kServerBackoffBaseMs = 30000UL;
constexpr unsigned long kServerBackoffCapMs = 300000UL;

// The retry interval that should be in effect after `consecutiveFailures`
// server failures in a row. 0 failures -> 0 (nothing has gone wrong yet, so
// always try).
inline unsigned long serverBackoffMs(uint32_t consecutiveFailures)
{
    if (consecutiveFailures == 0)
        return 0;
    unsigned long ms = kServerBackoffBaseMs;
    // consecutiveFailures - 1 doublings -- but the `ms < cap` half of the loop
    // condition means this converges (and stops doubling) in ~4 iterations no
    // matter how large consecutiveFailures gets, so an outage lasting days
    // costs the same handful of loop iterations as one lasting minutes.
    for (uint32_t i = 1; i < consecutiveFailures && ms < kServerBackoffCapMs; ++i)
        ms *= 2;
    return ms > kServerBackoffCapMs ? kServerBackoffCapMs : ms;
}

// Whether a fetch cycle should skip the server call entirely and go straight
// to the fallback, given the failure streak so far and how long it has been
// since the failure that (re)armed the current backoff window.
//
// `elapsedMs` must already be computed by the CALLER via unsigned subtraction
// against millis() (e.g. `millis() - lastFailureMs`) -- exactly the idiom
// FlightDataFetcher::withinEnrichBudget() uses and documents, which stays
// correct across the ~49.7-day millis() wrap where a stored absolute
// "retry-at" deadline compared with `millis() >= retryAt` would not. This
// function never calls millis() itself and never subtracts against it --
// it only compares magnitudes the caller already computed -- which is what
// keeps it a pure, host-testable function and keeps the wrap-sensitive
// arithmetic in exactly one place (the caller's native millis(), 32-bit on
// the real device).
inline bool shouldSkipServer(uint32_t consecutiveFailures, unsigned long elapsedMs)
{
    return elapsedMs < serverBackoffMs(consecutiveFailures);
}
