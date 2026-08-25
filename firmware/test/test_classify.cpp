// Host unit tests for FlightClassify.h — compile with g++, no hardware.
//
// Guarded so a `pio test` build doesn't collide with the other loose host
// tests under test/ -- see the test_filter comment in platformio.ini. This
// file is a standalone host test; it only runs via bare g++, which never
// defines PIO_UNIT_TESTING, so the guard is a no-op for that workflow and
// this file's behavior there is unchanged.
#ifndef PIO_UNIT_TESTING
#include "../utils/FlightClassify.h"
#include <cstdio>
#include <cstring>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    // isTailNumber() — positive registration signal
    CHECK(isTailNumber("N172SP"));   // US N-number
    CHECK(isTailNumber("N1"));       // minimal N-number (N + digit)
    CHECK(isTailNumber("N12345"));
    CHECK(isTailNumber("C-GABC"));   // hyphenated international registration

    // Airline-format callsigns must NEVER be classified as tail
    CHECK(!isTailNumber("DAL123"));
    CHECK(!isTailNumber("AAL2960"));
    CHECK(!isTailNumber("GTI4521"));  // Atlas: airline-format -> not a tail

    // Empty / null
    CHECK(!isTailNumber(""));
    CHECK(!isTailNumber(nullptr));

    // Whitespace tolerated on both ends
    CHECK(isTailNumber("  N99 "));

    // isCargoOperator() — curated freight-operator set
    CHECK(isCargoOperator("FDX"));
    CHECK(isCargoOperator("UPS"));
    CHECK(isCargoOperator("GTI"));
    CHECK(isCargoOperator("GEC"));
    CHECK(isCargoOperator("CLX"));
    CHECK(isCargoOperator("CKS"));
    CHECK(isCargoOperator("CAO"));
    CHECK(isCargoOperator("BOX"));
    CHECK(isCargoOperator("ABW"));
    CHECK(isCargoOperator("MPH"));
    CHECK(isCargoOperator("PAC"));
    CHECK(isCargoOperator("GSS"));
    CHECK(isCargoOperator("NCA"));
    CHECK(isCargoOperator("CKK"));
    CHECK(isCargoOperator("SQC"));
    CHECK(isCargoOperator("ABX"));
    CHECK(isCargoOperator("CJT"));
    CHECK(isCargoOperator("BCS"));
    CHECK(isCargoOperator("DHK"));

    // Non-cargo passenger operators
    CHECK(!isCargoOperator("DAL"));
    CHECK(!isCargoOperator("AAL"));
    CHECK(!isCargoOperator("UAL"));
    CHECK(!isCargoOperator("JBU"));
    CHECK(!isCargoOperator(""));
    CHECK(!isCargoOperator(nullptr));

    // Case-insensitive
    CHECK(isCargoOperator("fdx"));

    // isGeneralAviation() — the GA/private side of the airline split. This is
    // the predicate the "show general aviation" setting keys off on EVERY
    // source, so it has to agree with Area mode's two passes exactly: whatever
    // pass 1 (airline-format) refuses must land here, and nothing else.
    CHECK(isGeneralAviation("N172SP"));   // US N-number
    CHECK(isGeneralAviation("C-GABC"));   // hyphenated international registration
    CHECK(isGeneralAviation("N1"));

    // Broader than isTailNumber on purpose: a callsign that is neither
    // airline-format NOR registration-shaped is still not an airline flight,
    // and Area mode's pass 1 has always rejected it. Were this keyed on
    // isTailNumber instead, these would slip through a filter set to hide them.
    CHECK(isGeneralAviation("GOLF12"));
    CHECK(!isTailNumber("GOLF12"));       // ...and it is NOT a tail number
    CHECK(isGeneralAviation("LIFEGUARD"));
    CHECK(isGeneralAviation(""));
    CHECK(isGeneralAviation(nullptr));    // unknown is not an airline flight

    // Airline flights are never GA -- these must survive the filter.
    CHECK(!isGeneralAviation("DAL123"));
    CHECK(!isGeneralAviation("AAL2960"));
    CHECK(!isGeneralAviation("GTI4521"));  // cargo is an airline flight, not GA
    CHECK(!isGeneralAviation("QFA3"));     // shortest airline form: 3 letters + 1 digit
    CHECK(!isGeneralAviation("  BAW286 ")); // leading space tolerated, as in pass 1

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif // PIO_UNIT_TESTING
