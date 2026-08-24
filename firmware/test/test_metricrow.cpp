// Host unit tests for MetricRow.h — compile with g++, no hardware.
//
// Guarded like the other loose host tests under test/; see platformio.ini.
//
// WHY THIS EXISTS. displayMiniCard's second metric row used an if/else-if
// chain in which ETA, the flight number and vertical rate were MUTUALLY
// EXCLUSIVE -- only one could ever appear. That was a deliberate width
// compromise, and the code says so, but it means a card showing an ETA can
// never also show which flight it is. The comment there names the fix:
// "stop extending this if/else-if chain and instead fill the row from an
// ordered (label, value, priority) list against the column budget."
#ifndef PIO_UNIT_TESTING
#include "../utils/MetricRow.h"
#include <cstdio>
#include <string>
#include <vector>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    using V = std::vector<std::string>;

    // The case that motivated this: at 128px botCols is 21, and ETA plus a
    // flight number fit together where the old chain showed only one.
    CHECK(joinWithinColumns(V{"ETA:~7h10", "DL182"}, 21) == "ETA:~7h10 DL182");

    // Worst realistic widths still fit: LANDING is eta_text's longest value
    // and 7 chars is a long ADS-B callsign.
    CHECK(joinWithinColumns(V{"ETA:LANDING", "SWA1234"}, 21) == "ETA:LANDING SWA1234");

    // Priority order is the argument order. A later item that does not fit is
    // SKIPPED, not truncated -- and skipping it must not stop a shorter item
    // further down from being taken.
    CHECK(joinWithinColumns(V{"ETA:LANDING", "Trk:230deg", "Vr:0"}, 21) == "ETA:LANDING Vr:0");

    // Single item longer than the budget yields nothing rather than a
    // half-drawn string; the caller's truncateToColumns is the last resort,
    // not this.
    CHECK(joinWithinColumns(V{"ETA:ABSURDLYLONGVALUE"}, 10) == "");

    // Exact fit is a fit, off-by-one guarded on both sides.
    CHECK(joinWithinColumns(V{"ABCDE"}, 5) == "ABCDE");
    CHECK(joinWithinColumns(V{"ABCDEF"}, 5) == "");
    CHECK(joinWithinColumns(V{"AB", "CD"}, 5) == "AB CD");   // 2+1+2 = 5
    CHECK(joinWithinColumns(V{"AB", "CDE"}, 5) == "AB");     // 2+1+3 = 6, over

    // Empty candidates are dropped without leaving a stray separator.
    CHECK(joinWithinColumns(V{"", "DL182", ""}, 21) == "DL182");
    CHECK(joinWithinColumns(V{}, 21) == "");

    // A zero or negative budget cannot produce output.
    CHECK(joinWithinColumns(V{"DL182"}, 0) == "");
    CHECK(joinWithinColumns(V{"DL182"}, -1) == "");

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif
