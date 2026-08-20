// Host unit tests for RouteUtils.h — compile with g++, no hardware.
#include "../utils/RouteUtils.h"
#include <cstdio>
#include <cstring>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    char o[8], d[8];

    // Simple two-segment route.
    CHECK(parseFirstLeg("EGLL-KJFK", o, sizeof(o), d, sizeof(d)));
    CHECK(strcmp(o, "EGLL") == 0);
    CHECK(strcmp(d, "KJFK") == 0);

    // Rotation: take the FIRST leg, not first-and-last. This is the bug.
    CHECK(parseFirstLeg("KLAX-KDFW-KLAX", o, sizeof(o), d, sizeof(d)));
    CHECK(strcmp(o, "KLAX") == 0);
    CHECK(strcmp(d, "KDFW") == 0);   // NOT KLAX

    CHECK(parseFirstLeg("KDTW-KPHL-KDTW", o, sizeof(o), d, sizeof(d)));
    CHECK(strcmp(o, "KDTW") == 0);
    CHECK(strcmp(d, "KPHL") == 0);

    // Surrounding whitespace is trimmed.
    CHECK(parseFirstLeg("  KJFK - KLAX  ", o, sizeof(o), d, sizeof(d)));
    CHECK(strcmp(o, "KJFK") == 0);
    CHECK(strcmp(d, "KLAX") == 0);

    // Full isspace() set is trimmed, not just plain spaces -- matches
    // Arduino String::trim() (the code path this replaces). A narrower
    // predicate previously let a trailing CRLF survive into the output.
    CHECK(parseFirstLeg("EGLL-KJFK\r\n", o, sizeof(o), d, sizeof(d)));
    CHECK(strcmp(o, "EGLL") == 0);
    CHECK(strcmp(d, "KJFK") == 0);

    // Degenerate and malformed inputs are rejected, not guessed at.
    CHECK(!parseFirstLeg("KJFK-KJFK", o, sizeof(o), d, sizeof(d)));  // same both ends
    CHECK(!parseFirstLeg("KJFK", o, sizeof(o), d, sizeof(d)));       // one segment
    CHECK(!parseFirstLeg("", o, sizeof(o), d, sizeof(d)));
    CHECK(!parseFirstLeg(nullptr, o, sizeof(o), d, sizeof(d)));
    CHECK(!parseFirstLeg("-KJFK", o, sizeof(o), d, sizeof(d)));      // empty origin
    CHECK(!parseFirstLeg("KJFK-", o, sizeof(o), d, sizeof(d)));      // empty dest

    // A segment longer than the caller's buffer is rejected rather than truncated,
    // because a truncated ICAO code is a different, real airport.
    char tiny[3];
    CHECK(!parseFirstLeg("EGLL-KJFK", tiny, sizeof(tiny), d, sizeof(d)));

    // Exact-fit boundary: a 4-char code plus NUL fits exactly in a 5-byte
    // buffer and must SUCCEED. Guards against an inverted capacity comparison.
    char exact[5];
    CHECK(parseFirstLeg("EGLL-KJFK", exact, sizeof(exact), d, sizeof(d)));
    CHECK(strcmp(exact, "EGLL") == 0);

    // On failure the outputs are cleared, so a caller that ignores the return
    // value cannot read a stale code from a previous call.
    strcpy(o, "XXXX");
    CHECK(!parseFirstLeg("KJFK", o, sizeof(o), d, sizeof(d)));
    CHECK(o[0] == '\0');

    // A failed DEST must also clear the origin that was already written: here
    // the origin copy succeeds (o has room) before the dest copy fails (3
    // bytes is too small for "KJFK"), so this exercises the re-clear branch
    // with real, already-written origin data -- unlike the `tiny` case above,
    // where origin fails first and dest is never reached.
    char smallDest[3];
    strcpy(o, "XXXX");
    CHECK(!parseFirstLeg("EGLL-KJFK", o, sizeof(o), smallDest, sizeof(smallDest)));
    CHECK(o[0] == '\0');

    if (failures == 0) printf("test_route: ALL PASS\n");
    return failures ? 1 : 0;
}
