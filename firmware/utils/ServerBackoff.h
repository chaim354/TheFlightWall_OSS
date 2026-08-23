#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h.
#include <cstdint>

// Escalating retry backoff for the FlightWall-server call specifically (see
// FlightDataFetcher::fetchServerMode).
//
// THE ORIGINAL PREMISE WAS MEASURED FALSE. This schedule was tuned on the
// assumption -- stated in this comment -- that "this source has a working
// fallback (adsb.lol) sitting right behind it", which made skipping the server
// cheap: the panel would still update from the fallback. Over a 60-minute
// window on real hardware, adsb.lol succeeded 0 times in 46 cycles. There is no
// working fallback, so a skipped cycle is not a cheaper path to the same data,
// it is a cycle where the panel shows nothing new.
//
// That inverts the trade. A failed attempt is bounded and cheap (one 4s
// handshake); a skipped cycle is a minute of stale display. So the cap comes
// down from 300s to 120s. Measured against the same hour: the two failure
// clusters cost 4m52s and 3m37s of stale panel, nearly all of it backoff
// rather than fetching, and a 120s cap would have cut roughly 4.5 minutes off
// the ~9 minutes of staleness across the hour.
//
// The base is deliberately unchanged -- see below.
//
// Historic note, kept because it explains the shape: this source's shortened
// per-call timeouts (4s handshake, 4s read; see FlightWallServerFetcher's
// secureClient()) are the other half of the same fix, bounding the cost of any
// ONE failed attempt --
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
//   Cap   120s  -- reached after 3 failures (30 -> 60 -> 120), so a real
//                  outage settles into "try every 2 minutes" rather than every
//                  5. Still bounds the load during a genuine outage, but
//                  recovers within about one cycle of the server returning
//                  instead of up to five. The cap bounds the WAIT, not the
//                  attempt count -- the next attempt after it is always a real
//                  one, never a permanent give-up.
//                  Measured failure shape that justifies the shorter cap: over
//                  an hour, failures came in two short clusters (3 then 2)
//                  separated by 25 and 14 consecutive clean cycles. A long cap
//                  is priced for a sustained outage; what actually happens is
//                  brief blips, where a long cap is pure added staleness.
constexpr unsigned long kServerBackoffBaseMs = 30000UL;
constexpr unsigned long kServerBackoffCapMs = 120000UL;

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
