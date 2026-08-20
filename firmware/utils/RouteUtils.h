#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h.
#include <cstddef>

// hexdb's /route/icao/ returns a whole ROTATION, not a single leg:
// "KLAX-KDFW-KLAX" is LAX->DFW->LAX. The original code took the first segment and
// the LAST segment, which renders that round trip as "LAX -> LAX" on the wall.
// 27% of sampled routes are multi-leg, so this was common rather than exotic.
//
// We take the FIRST leg. Without the aircraft's position there is no way to know
// which leg it is currently flying, and the first leg is at least always a real
// one. Callers that DO have a position should select the leg themselves.
//
// Writes NUL-terminated codes into outOrigin/outDest (caps include the NUL) and
// returns true. On any failure both outputs are set to "" and it returns false —
// a segment that does not fit is rejected rather than truncated, because a
// truncated ICAO code names a different, real airport.
inline bool parseFirstLeg(const char *route,
                          char *outOrigin, size_t originCap,
                          char *outDest, size_t destCap)
{
    if (outOrigin && originCap) outOrigin[0] = '\0';
    if (outDest && destCap) outDest[0] = '\0';
    if (!route || !outOrigin || !outDest || originCap == 0 || destCap == 0)
        return false;

    auto isSpace = [](char c) { return c == ' ' || c == '\t'; };

    // Copy route[from,to) into out, trimming spaces. False if empty or too long.
    auto emit = [&](size_t from, size_t to, char *out, size_t cap) {
        while (from < to && isSpace(route[from])) from++;
        while (to > from && isSpace(route[to - 1])) to--;
        const size_t n = to - from;
        if (n == 0 || n + 1 > cap)
            return false;
        for (size_t i = 0; i < n; ++i)
            out[i] = route[from + i];
        out[n] = '\0';
        return true;
    };

    size_t len = 0;
    while (route[len] != '\0') len++;

    // First separator ends segment 1; second (or end of string) ends segment 2.
    size_t d1 = 0;
    while (d1 < len && route[d1] != '-') d1++;
    if (d1 == len)
        return false; // no separator: a single segment is not a leg

    size_t d2 = d1 + 1;
    while (d2 < len && route[d2] != '-') d2++;

    if (!emit(0, d1, outOrigin, originCap) || !emit(d1 + 1, d2, outDest, destCap))
    {
        outOrigin[0] = '\0';
        outDest[0] = '\0';
        return false;
    }

    // A leg that starts and ends at the same airport is not a leg. This is exactly
    // what the old first-and-last split produced for every round trip.
    size_t i = 0;
    while (outOrigin[i] != '\0' && outOrigin[i] == outDest[i]) i++;
    if (outOrigin[i] == '\0' && outDest[i] == '\0')
    {
        outOrigin[0] = '\0';
        outDest[0] = '\0';
        return false;
    }
    return true;
}
