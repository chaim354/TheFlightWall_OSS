// Host unit tests for utils/CodeList.h -- compile with g++, no hardware.
//
// Guarded so a `pio test` build doesn't collide with the other loose host
// tests under test/ -- see the comment in platformio.ini. Bare g++ never
// defines PIO_UNIT_TESTING, so the guard is a no-op for that workflow.
#ifndef PIO_UNIT_TESTING
#include "../utils/CodeList.h"
#include <cstdio>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    // The shapes both airline lists are meant to hold.
    CHECK(isPlainOperatorCode("EJA"));
    CHECK(isPlainOperatorCode("DL"));
    CHECK(isPlainOperatorCode("9W"));
    CHECK(isPlainOperatorCode("eja")); // case is the device's business, not this check's

    // Wrong length.
    CHECK(!isPlainOperatorCode("E"));
    CHECK(!isPlainOperatorCode("EJAX"));
    CHECK(!isPlainOperatorCode(""));
    CHECK(!isPlainOperatorCode(nullptr));

    // Anything that could cut a query string short, or is not a code at all.
    CHECK(!isPlainOperatorCode("E&A"));
    CHECK(!isPlainOperatorCode("EJ "));
    CHECK(!isPlainOperatorCode("E#A"));
    CHECK(!isPlainOperatorCode("A=B"));

    if (failures) { printf("%d FAILED\n", failures); return 1; }
    printf("ALL PASS\n");
    return 0;
}
#endif
