// Host unit tests for pinned-flight ordering — compile with g++, no hardware.
//
// Guarded like the other loose host tests under test/; see platformio.ini.
#ifndef PIO_UNIT_TESTING
#include "../utils/PinSort.h"
#include <cstdio>
#include <vector>
#include <string>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

struct Row { std::string id; bool pinned; double dist; };

int main() {
    // Pinned first, and WITHIN each group the existing nearest-first order is
    // preserved -- pinning changes which group a card is in, not the sort.
    std::vector<Row> v = {
        {"far",       false, 30.0},
        {"pinned-far",true,  90.0},
        {"near",      false, 2.0},
        {"pinned-nr", true,  10.0},
    };
    stablePinFirst(v, [](const Row &r) { return r.pinned; });
    CHECK(v[0].id == "pinned-far");
    CHECK(v[1].id == "pinned-nr");
    CHECK(v[2].id == "far");
    CHECK(v[3].id == "near");

    // No pinned rows: order is untouched.
    std::vector<Row> none = {{"a", false, 1.0}, {"b", false, 2.0}};
    stablePinFirst(none, [](const Row &r) { return r.pinned; });
    CHECK(none[0].id == "a");
    CHECK(none[1].id == "b");

    // All pinned: also untouched.
    std::vector<Row> all = {{"a", true, 1.0}, {"b", true, 2.0}};
    stablePinFirst(all, [](const Row &r) { return r.pinned; });
    CHECK(all[0].id == "a");

    // Empty is not a crash.
    std::vector<Row> empty;
    stablePinFirst(empty, [](const Row &r) { return r.pinned; });
    CHECK(empty.empty());

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif
