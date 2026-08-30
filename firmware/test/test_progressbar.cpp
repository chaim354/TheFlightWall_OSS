// Host unit tests for ProgressBar.h — compile with g++, no hardware.
//
// Guarded like the other loose host tests under test/; see platformio.ini.
#ifndef PIO_UNIT_TESTING
#include "../utils/ProgressBar.h"
#include <cstdio>
#include <cmath>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    // The real geometry: a 128px panel, 1px border each side.
    const int W = 126;

    // The two ends are exact, and they are the only values allowed to be
    // exact. Empty means "has not left"; full means "should be down".
    CHECK(progressFillPixels(0.0, W) == 0);
    CHECK(progressFillPixels(100.0, W) == W);

    // Ordinary readings scale linearly and round to the nearest pixel.
    CHECK(progressFillPixels(50.0, W) == 63);
    CHECK(progressFillPixels(25.0, W) == 32); // 31.5 rounds up
    CHECK(progressFillPixels(10.0, W) == 13); // 12.6 rounds up

    // JUST DEPARTED must not read as not-departed. 0.2% of 126 is 0.25px,
    // which rounds to nothing -- so the first half hour of a long-haul flight
    // would be indistinguishable from a card carrying no progress at all.
    CHECK(progressFillPixels(0.2, W) == 1);
    CHECK(progressFillPixels(0.0001, W) == 1);

    // ALMOST THERE must not read as arrived, for the mirror-image reason:
    // 99.8% rounds to the full width, which says "landed" of an aeroplane
    // still fifteen minutes out.
    CHECK(progressFillPixels(99.8, W) == W - 1);
    CHECK(progressFillPixels(99.99999, W) == W - 1);

    // Out of range is clamped, not wrapped. The server promises 0-100; this
    // is what happens when a future one does not, and the upper clamp is the
    // one that would otherwise write past the end of the canvas row.
    CHECK(progressFillPixels(-1.0, W) == 0);
    CHECK(progressFillPixels(-1e9, W) == 0);
    CHECK(progressFillPixels(140.0, W) == W);
    CHECK(progressFillPixels(1e9, W) == W);

    // Non-finite is zero, not undefined behaviour. NAN fails every comparison,
    // so without the explicit guard it reaches the cast having passed the
    // clamp -- and NAN is exactly what the wire parser produces for an absent
    // field (see utils/ServerJson.h).
    CHECK(progressFillPixels(NAN, W) == 0);
    CHECK(progressFillPixels(INFINITY, W) == 0);
    CHECK(progressFillPixels(-INFINITY, W) == 0);

    // Degenerate tracks yield nothing rather than a negative width. A 1px
    // track can only ever be empty or full, and the "never exactly full"
    // rule cannot also hold there -- full wins, because trackWidth-1 would
    // be 0 and silently mean "not departed".
    CHECK(progressFillPixels(50.0, 0) == 0);
    CHECK(progressFillPixels(50.0, -5) == 0);
    CHECK(progressFillPixels(100.0, 1) == 1);

    if (failures == 0) printf("test_progressbar: ALL PASS\n");
    return failures == 0 ? 0 : 1;
}
#endif
