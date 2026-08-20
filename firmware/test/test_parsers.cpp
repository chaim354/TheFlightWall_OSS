// Host unit tests for CallsignUtils.h — compile with g++, no hardware.
//
// Guarded so a `pio test` build doesn't collide with the other loose host
// tests under test/ -- see the test_filter comment in platformio.ini. This
// file is a standalone host test; it only runs via bare g++, which never
// defines PIO_UNIT_TESTING, so the guard is a no-op for that workflow and
// this file's behavior there is unchanged.
#ifndef PIO_UNIT_TESTING
#include "../utils/CallsignUtils.h"
#include <cstdio>
#include <cstring>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    char out[4];

    // Airline-format callsigns -> 3-letter ICAO prefix
    CHECK(parseAirlineIcao("AAL2960", out) && strcmp(out, "AAL") == 0);
    CHECK(parseAirlineIcao("AFR8F", out)   && strcmp(out, "AFR") == 0);
    CHECK(parseAirlineIcao("qfa3", out)    && strcmp(out, "QFA") == 0);   // lowercase -> upper
    CHECK(parseAirlineIcao("  DAL123 ", out) && strcmp(out, "DAL") == 0); // leading space

    // Tail numbers / junk -> no prefix
    CHECK(!parseAirlineIcao("N172SP", out));   // 4th char not a digit
    CHECK(!parseAirlineIcao("AA", out));       // too short
    CHECK(!parseAirlineIcao("", out));
    CHECK(!parseAirlineIcao(nullptr, out));

    // Cache action policy
    CHECK(cacheActionFor(false, false, 0,      600000, 60000) == CacheAction::Fetch);        // miss
    CHECK(cacheActionFor(true,  true,  100000, 600000, 60000) == CacheAction::UseValid);     // fresh positive
    CHECK(cacheActionFor(true,  true,  700000, 600000, 60000) == CacheAction::Fetch);        // expired positive
    CHECK(cacheActionFor(true,  false, 30000,  600000, 60000) == CacheAction::SkipNegative); // fresh negative
    CHECK(cacheActionFor(true,  false, 90000,  600000, 60000) == CacheAction::Fetch);        // expired negative -> retry

    // Enrichment cache key: the callsign identifies the LEG and so must win over
    // the airframe. ICAO24 is only a fallback when there is no callsign.
    CHECK(strcmp(enrichmentCacheKey("EDV5075", "a1b2c3"), "EDV5075") == 0);
    CHECK(strcmp(enrichmentCacheKey("", "a1b2c3"), "a1b2c3") == 0);
    CHECK(strcmp(enrichmentCacheKey(nullptr, "a1b2c3"), "a1b2c3") == 0);
    CHECK(strcmp(enrichmentCacheKey("EDV5075", ""), "EDV5075") == 0);
    CHECK(strcmp(enrichmentCacheKey("", ""), "") == 0);
    CHECK(strcmp(enrichmentCacheKey(nullptr, nullptr), "") == 0);

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif // PIO_UNIT_TESTING
