// Host unit tests for FlightClassify.h — compile with g++, no hardware.
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

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
