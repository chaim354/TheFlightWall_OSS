// Host unit tests for FetchCadence.h — compile with g++, no hardware.
//
// Guarded so a `pio test` build doesn't pull this into the on-device test
// binary; see the comment in platformio.ini. Under the bare-g++ workflow
// PIO_UNIT_TESTING is never defined, so the guard is a no-op there.
#ifndef PIO_UNIT_TESTING
#include "../utils/FetchCadence.h"
#include <cstdio>
#include <initializer_list>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    const unsigned long base = 30000UL; // the shipped default, 30s

    // ---- migration contract: the quiet cases must not move ----
    CHECK(fetchIntervalMs(base, 0, 0) == base);
    CHECK(fetchIntervalMs(base, 0, 1) == base);
    CHECK(fetchIntervalMs(base, 0, kEmptyConfirmCycles - 1) == base);

    // ---- failure ladder: doubles per failure, capped at 5 min ----
    CHECK(fetchIntervalMs(base, 1, 0) == 60000UL);
    CHECK(fetchIntervalMs(base, 2, 0) == 120000UL);
    CHECK(fetchIntervalMs(base, 3, 0) == 240000UL);
    CHECK(fetchIntervalMs(base, 4, 0) == 300000UL);   // 480s clamped to the 5min cap
    CHECK(fetchIntervalMs(base, 40, 0) == 300000UL);  // shift saturates, no overflow

    // ---- empty ladder: engages on the 2nd empty, capped at 2 min ----
    CHECK(fetchIntervalMs(base, 0, kEmptyConfirmCycles) == 60000UL);
    CHECK(fetchIntervalMs(base, 0, kEmptyConfirmCycles + 1) == 120000UL);
    CHECK(fetchIntervalMs(base, 0, kEmptyConfirmCycles + 9) == 120000UL); // capped

    // ---- THE BUG: a stale failure count must not SHORTEN the interval ----
    //
    // The ladders were if/else if, so any non-zero failure count suppressed the
    // empty ladder entirely. One transient failure leaves failures==1 forever
    // (only a non-empty fetch clears it), so a source rate-limiting us with
    // well-formed empty replies got 60s from the failure ladder instead of the
    // 120s the empty ladder demanded -- the stale counter HALVED the exact
    // protection the empty ladder exists to provide.
    CHECK(fetchIntervalMs(base, 1, kEmptyConfirmCycles + 1) == 120000UL);

    // Pressure only ever lengthens: never below either ladder alone.
    for (uint8_t f = 0; f <= 6; ++f)
        for (uint8_t e = 0; e <= 6; ++e) {
            const unsigned long both = fetchIntervalMs(base, f, e);
            CHECK(both >= fetchIntervalMs(base, f, 0));
            CHECK(both >= fetchIntervalMs(base, 0, e));
            CHECK(both >= base);
        }

    // ---- a backoff must never SHORTEN the interval ----
    //
    // The old code clamped to the cap unconditionally, so a configured interval
    // longer than the cap got shorter under pressure: 400s base + one failure =
    // 800s backoff, clamped to the 300s cap, i.e. polling MORE often while the
    // API was failing. Preserved deliberately as the invariant below.
    CHECK(fetchIntervalMs(400000UL, 1, 0) == 400000UL);
    CHECK(fetchIntervalMs(400000UL, 4, 0) == 400000UL);
    CHECK(fetchIntervalMs(400000UL, 0, kEmptyConfirmCycles + 1) == 400000UL);

    // And a pathological configured interval must not wrap into a short one.
    // Settings applies no upper clamp (only an HTML min="5" hint).
    for (unsigned long b : {5000UL, 30000UL, 400000UL, 4000000000UL})
        for (uint8_t f = 0; f <= 8; ++f)
            for (uint8_t e = 0; e <= 8; ++e)
                CHECK(fetchIntervalMs(b, f, e) >= b);

    if (failures == 0) { printf("test_fetchcadence: ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif // PIO_UNIT_TESTING
