// Host unit tests for ServerJson.h — compile with g++, no hardware, no ArduinoJson.
//
// Guarded so a `pio test` build doesn't collide with the other loose host
// tests under test/ -- see the test_filter comment in platformio.ini. This
// file is a standalone host test; it only runs via bare g++, which never
// defines PIO_UNIT_TESTING, so the guard is a no-op for that workflow and
// this file's behavior there is unchanged.
#ifndef PIO_UNIT_TESTING
#include "../utils/ServerJson.h"
#include <cstdio>
#include <cmath>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    // present -> value, absent -> NAN. Zero is a REAL value, not "unknown".
    CHECK(optionalNumber(true, 8025.0) == 8025.0);
    CHECK(optionalNumber(true, 0.0) == 0.0);      // sea level is not unknown
    CHECK(optionalNumber(true, -1200.0) == -1200.0);
    CHECK(std::isnan(optionalNumber(false, 8025.0)));
    CHECK(std::isnan(optionalNumber(false, 0.0)));

    // A non-finite value on the wire is unknown, not a number to render.
    CHECK(std::isnan(optionalNumber(true, NAN)));
    CHECK(std::isnan(optionalNumber(true, INFINITY)));
    CHECK(std::isnan(optionalNumber(true, -INFINITY)));

    // renderable: what the display asks before printing a number.
    CHECK(renderable(8025.0));
    CHECK(renderable(0.0));
    CHECK(renderable(-1200.0));
    CHECK(!renderable(NAN));
    CHECK(!renderable(INFINITY));

    if (failures == 0) printf("test_serverjson: ALL PASS\n");
    return failures ? 1 : 0;
}
#endif // PIO_UNIT_TESTING
