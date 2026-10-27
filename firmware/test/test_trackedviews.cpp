// Host unit tests for TrackedViews.h -- compile with g++, no hardware.
//
// Guarded like the other loose host tests under test/; see platformio.ini.
#ifndef PIO_UNIT_TESTING
#include "../utils/TrackedViews.h"
#include <cstdio>
#include <string>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    using S = std::string;

    // --- timing ------------------------------------------------------------
    // Three views share the fifteen seconds equally, in order.
    CHECK(trackedViewAt(0, 3) == 0);
    CHECK(trackedViewAt(4999, 3) == 0);
    CHECK(trackedViewAt(5000, 3) == 1);
    CHECK(trackedViewAt(9999, 3) == 1);
    CHECK(trackedViewAt(10000, 3) == 2);
    CHECK(trackedViewAt(14999, 3) == 2);

    // A lone tracked card is never replaced, so the views must keep turning
    // over rather than sticking on the last one.
    CHECK(trackedViewAt(15000, 3) == 0);
    CHECK(trackedViewAt(20000, 3) == 1);
    CHECK(trackedViewAt(3600000UL + 10000, 3) == 2);

    // Two views (no place over open ocean) get 7.5s each, not 5s and a gap.
    CHECK(trackedViewAt(7499, 2) == 0);
    CHECK(trackedViewAt(7500, 2) == 1);

    // One view, or none, is always view 0 -- never a division by zero.
    CHECK(trackedViewAt(123456, 1) == 0);
    CHECK(trackedViewAt(123456, 0) == 0);
    CHECK(trackedViewAt(5, 3, 0) == 0);

    // --- the 128px wall: 21 columns -----------------------------------------
    const int W = 21;
    CHECK(departedLine(S("20 min"), W) == "Departed 20 min ago");
    CHECK(departedLine(S("3.5 hr"), W) == "Departed 3.5 hr ago");
    // The widest the server sends, on a long-haul: 20 columns.
    CHECK(departedLine(S("10.5 hr"), W) == "Departed 10.5 hr ago");
    CHECK(arrivingLine(S("3.5 hr"), W) == "Arriving in 3.5 hr");
    CHECK(arrivingLine(S("20 min"), W) == "Arriving in 20 min");
    // An older server's eta_text still makes a sentence.
    CHECK(arrivingLine(S("1h05"), W) == "Arriving in 1h05");
    // LANDING is a state, not a duration.
    CHECK(arrivingLine(S("LANDING"), W) == "Landing now");
    CHECK(placeLabel<S>(false, W) == "Flying over");
    CHECK(placeLabel<S>(true, W) == "Flying near");
    CHECK(placeLine(S("Springfield"), S("IL"), W) == "Springfield, IL");

    // Absent input is an absent line, never a stray label.
    CHECK(departedLine(S(""), W).empty());
    CHECK(arrivingLine(S(""), W).empty());
    CHECK(placeLine(S(""), S("IL"), W).empty());
    CHECK(placeLine(S("Gander"), S(""), W) == "Gander");

    // --- narrow panels shorten rather than truncate -------------------------
    // A 64px stacked card has 10 columns.
    CHECK(departedLine(S("3.5 hr"), 14) == "Dep 3.5 hr ago");
    CHECK(departedLine(S("3.5 hr"), 10) == "Dep 3.5 hr");
    CHECK(arrivingLine(S("3.5 hr"), 13) == "Arr in 3.5 hr");
    CHECK(arrivingLine(S("3.5 hr"), 10) == "Arr 3.5 hr");
    CHECK(arrivingLine(S("LANDING"), 10) == "Landing");
    CHECK(placeLabel<S>(false, 10) == "Over");
    // The region goes before the name is cut.
    CHECK(placeLine(S("Saint-Jean-sur-Richelieu"), S("QC"), W) == "Saint-Jean-sur-Richelieu");
    CHECK(placeLine(S("Lyon"), S("France"), 10) == "Lyon");
    // Nothing fits: the shortest form comes back for the caller to clamp.
    CHECK(departedLine(S("3.5 hr"), 3) == "Dep 3.5 hr");

    // --- miles flown --------------------------------------------------------
    CHECK(flownText<S>(989.0, true) == "989mi flown");
    CHECK(flownText<S>(989.4, false) == "989mi");
    CHECK(flownText<S>(0.0, false) == "0mi");
    CHECK(flownText<S>(7999.6, false) == "8000mi");
    // The pair that has to share the wall's second row: "ETA:1h05" (8) plus
    // a space plus "989mi flown" (11) is 20, inside 21.
    CHECK(S("ETA:1h05 ") .length() + flownText<S>(989, true).length() == 20);

    if (failures) {
        printf("%d FAILURE(S)\n", failures);
        return 1;
    }
    printf("ALL PASS\n");
    return 0;
}
#endif
