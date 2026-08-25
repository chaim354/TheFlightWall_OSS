#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h.
//
// Two POSITIVE classifiers used to identify private/GA and cargo flights.
//
// CRITICAL design rule: "private/tail" must be a POSITIVE signal — the callsign
// itself looks like an aircraft registration. It must NEVER mean "enrichment
// failed". Airline-format callsigns (3 letters + a digit, e.g. DAL123, GTI4521)
// must NEVER be classified as a tail number.
#include <cctype>
#include <cstddef>
#include <cstring>
#include "CallsignUtils.h"

// isTailNumber: positive "this is an aircraft registration, not an airline
// flight" test. Conservative — unknown/ambiguous input is NOT auto-private.
inline bool isTailNumber(const char *callsign)
{
    if (!callsign)
        return false;

    // Trim both ends into start/end indices over the original buffer.
    const char *start = callsign;
    while (*start == ' ')
        start++;
    const char *end = start + std::strlen(start);
    while (end > start && *(end - 1) == ' ')
        end--;

    size_t len = (size_t)(end - start);
    if (len == 0)
        return false; // empty after trim

    // Copy trimmed view into a fixed local buffer for downstream string checks.
    char buf[32];
    size_t n = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
    std::memcpy(buf, start, n);
    buf[n] = '\0';

    // Airline flight (3 letters + digit) is never a tail number.
    char icao[4];
    if (parseAirlineIcao(buf, icao))
        return false;

    // Registration signals (any one is sufficient):
    //  * US N-number: leading 'N'/'n' followed by a digit.
    if ((buf[0] == 'N' || buf[0] == 'n') &&
        buf[1] >= '0' && buf[1] <= '9')
        return true;

    //  * hyphenated international registration (e.g. C-GABC, G-EUOA).
    if (std::strchr(buf, '-') != nullptr)
        return true;

    // Conservative: unknown / ambiguous is NOT auto-private.
    return false;
}

// isGeneralAviation: the GA/private side of the airline split, as ONE named
// predicate.
//
// "General aviation" here means exactly what Area mode's two-pass carousel has
// always meant by it: the callsign is not airline-format. That is deliberately
// BROADER than isTailNumber above -- a tail number is GA, but so is a
// non-airline callsign that is not registration-shaped either, and both belong
// on the same side of the split. Naming it once is what stops the two passes
// and the FlightWall-server path from drifting into different answers for the
// same aircraft, which is precisely what had happened: the server path applied
// hideCargo and the airline allow-list but never this rule, so a device set to
// that source showed GA traffic no matter how the setting was left.
//
// Takes the CALLSIGN, not a classified flight, so it stays usable at the point
// in Area mode where nothing has been enriched yet.
inline bool isGeneralAviation(const char *callsign)
{
    char icao[4];
    return !parseAirlineIcao(callsign, icao);
}

// isCargoOperator: membership in a curated freight-operator ICAO set
// (case-insensitive 3-letter compare).
inline bool isCargoOperator(const char *icao)
{
    if (!icao || icao[0] == '\0')
        return false;

    static const char *const kCargoIcao[] = {
        "FDX", "UPS", "GTI", "GEC", "CLX", "CKS", "CAO", "BOX", "ABW", "MPH",
        "PAC", "GSS", "NCA", "CKK", "SQC", "ABX", "CJT", "BCS", "DHK",
    };
    const size_t kCargoCount = sizeof(kCargoIcao) / sizeof(kCargoIcao[0]);

    // Uppercase the first three characters of the input.
    char up[4] = {0, 0, 0, 0};
    for (int i = 0; i < 3; ++i) {
        if (icao[i] == '\0')
            return false; // shorter than 3 chars -> cannot match any entry
        up[i] = (char)std::toupper((unsigned char)icao[i]);
    }

    for (size_t i = 0; i < kCargoCount; ++i) {
        if (up[0] == kCargoIcao[i][0] &&
            up[1] == kCargoIcao[i][1] &&
            up[2] == kCargoIcao[i][2])
            return true;
    }
    return false;
}
