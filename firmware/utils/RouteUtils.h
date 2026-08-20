#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h.
#include <cctype>
#include <cstddef>
#include <cstring>

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

    // Matches Arduino String::trim() (the code path this replaces), which trims
    // the full isspace() set -- space, \t, \n, \v, \f, \r -- not just plain
    // spaces. A narrower predicate here would let e.g. a trailing "\r\n" survive
    // into the output and render as garbage on the LED panel instead of being
    // trimmed or rejected.
    auto isSpace = [](char c) { return std::isspace(static_cast<unsigned char>(c)) != 0; };

    // Copy route[from,to) into out, trimming whitespace. False if empty or too
    // long for the destination buffer (cap includes the NUL).
    auto copyTrimmedSegment = [&](size_t from, size_t to, char *out, size_t cap) {
        while (from < to && isSpace(route[from])) from++;
        while (to > from && isSpace(route[to - 1])) to--;
        const size_t n = to - from;
        if (n == 0 || n >= cap)
            return false;
        for (size_t i = 0; i < n; ++i)
            out[i] = route[from + i];
        out[n] = '\0';
        return true;
    };

    // First separator ends segment 1; second separator (or end of string) ends
    // segment 2. Scanning for '\0' directly -- rather than pre-computing
    // strlen(route) and bounding both scans by it -- makes this one pass over
    // `route` instead of two.
    size_t d1 = 0;
    while (route[d1] != '\0' && route[d1] != '-') d1++;
    if (route[d1] == '\0')
        return false; // no separator: a single segment is not a leg

    size_t d2 = d1 + 1;
    while (route[d2] != '\0' && route[d2] != '-') d2++;

    if (!copyTrimmedSegment(0, d1, outOrigin, originCap) || !copyTrimmedSegment(d1 + 1, d2, outDest, destCap))
    {
        // Not redundant with the clear at function entry: if the origin copy
        // above succeeded and the dest copy then failed, outOrigin already holds
        // a real parsed value that must not leak to a caller that ignores the
        // return value.
        outOrigin[0] = '\0';
        outDest[0] = '\0';
        return false;
    }

    // A leg that starts and ends at the same airport is not a leg. This is exactly
    // what the old first-and-last split produced for every round trip.
    if (strcmp(outOrigin, outDest) == 0)
    {
        outOrigin[0] = '\0';
        outDest[0] = '\0';
        return false;
    }
    return true;
}
