// Host unit tests for ServerBackoff.h — compile with g++, no hardware.
//
// Guarded so a `pio test` build doesn't collide with the other loose host
// tests under test/ -- see the test_filter comment in platformio.ini. This
// file is a standalone host test; it only runs via bare g++, which never
// defines PIO_UNIT_TESTING, so the guard is a no-op for that workflow and
// this file's behavior there is unchanged.
#ifndef PIO_UNIT_TESTING
#include "../utils/ServerBackoff.h"
#include <cstdint>
#include <cstdio>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    // serverBackoffMs() — no failures yet means no backoff.
    CHECK(serverBackoffMs(0) == 0UL);

    // Doubling schedule: base 30s, x2 per additional failure.
    CHECK(serverBackoffMs(1) == 30000UL);
    CHECK(serverBackoffMs(2) == 60000UL);
    CHECK(serverBackoffMs(3) == 120000UL);
    CHECK(serverBackoffMs(4) == 240000UL);

    // Cap: failure 5 would double to 480s, which exceeds the 300s cap, so it
    // clamps instead.
    CHECK(serverBackoffMs(5) == 300000UL);

    // Once capped, stays capped -- including for a failure count far larger
    // than would ever occur in practice, which also proves the loop
    // terminates promptly rather than doubling all the way up.
    CHECK(serverBackoffMs(6) == 300000UL);
    CHECK(serverBackoffMs(20) == 300000UL);
    CHECK(serverBackoffMs(1000000) == 300000UL);

    // shouldSkipServer() — no failure history means never skip, regardless of
    // the (meaningless, in this case) elapsed value.
    CHECK(!shouldSkipServer(0, 0));
    CHECK(!shouldSkipServer(0, 999999999UL));

    // First failure: skip until the 30s boundary, then allow a retry. The
    // boundary itself (elapsed == backoff) is NOT a skip -- elapsed must be
    // STRICTLY less than the backoff to still be waiting, so a caller that
    // checks on or after the deadline gets to try again on that exact cycle
    // rather than needing to overshoot it.
    CHECK(shouldSkipServer(1, 0));
    CHECK(shouldSkipServer(1, 29999UL));
    CHECK(!shouldSkipServer(1, 30000UL));
    CHECK(!shouldSkipServer(1, 30001UL));

    // Escalated (4th consecutive failure -> 240s) and capped (5th -> 300s)
    // windows follow the same strictly-less-than boundary rule.
    CHECK(shouldSkipServer(4, 239999UL));
    CHECK(!shouldSkipServer(4, 240000UL));
    CHECK(shouldSkipServer(5, 299999UL));
    CHECK(!shouldSkipServer(5, 300000UL));

    // Wrap-safety, demonstrated the way the real caller
    // (FlightDataFetcher::serverBackoffActive) computes elapsedMs: unsigned
    // subtraction against millis(), which on the actual 32-bit device wraps
    // correctly at the ~49.7-day rollover. shouldSkipServer()/serverBackoffMs()
    // never call millis() themselves (see the header comment) -- the
    // subtraction is entirely the caller's responsibility -- so this exercises
    // that idiom explicitly with uint32_t, the type millis() actually returns
    // on-device, rather than this test's host `unsigned long` (64-bit here),
    // which would never wrap and so would prove nothing.
    {
        uint32_t lastFailureMs = UINT32_MAX; // one tick before the uint32_t wrap
        uint32_t nowMs = 500U;               // now: wrapped around to 500
        // True elapsed time is 1ms (UINT32_MAX -> 0) + 500ms (0 -> 500) = 501ms.
        // Unsigned subtraction in 32-bit space gets this right in one step --
        // (500 - 4294967295) mod 2^32 = 501 -- while a signed or wider naive
        // comparison of the raw values would see nowMs "before" lastFailureMs
        // and get elapsed backwards.
        uint32_t elapsed32 = nowMs - lastFailureMs;
        CHECK(elapsed32 == 501U);

        unsigned long elapsed = elapsed32; // widen only AFTER the wrap-safe subtraction
        CHECK(shouldSkipServer(1, elapsed));              // 501ms into a 30000ms backoff
        CHECK(!shouldSkipServer(1, elapsed + 29499UL));    // 30000ms in -> retry allowed
    }

    if (failures == 0) { printf("test_serverbackoff: ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif // PIO_UNIT_TESTING
