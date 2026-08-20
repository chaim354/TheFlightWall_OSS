#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h.
#include <cctype>
#include <cstddef>

// Airline ICAO from an airline-format callsign: "QFA3"->"QFA", "AAL2960"->"AAL".
// Tail numbers like "N172SP" (4th char not a digit) yield no prefix.
// Skips leading spaces. Writes 3 uppercase letters + NUL into out[4].
// Returns true iff a prefix was found.
inline bool parseAirlineIcao(const char *callsign, char out[4])
{
    out[0] = '\0';
    if (!callsign)
        return false;
    const char *c = callsign;
    while (*c == ' ')
        c++;
    auto isAlpha = [](char ch) { return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'); };
    if (!isAlpha(c[0]) || !isAlpha(c[1]) || !isAlpha(c[2]))
        return false;
    if (c[3] < '0' || c[3] > '9') // 4th char must be a digit (flight number)
        return false;
    for (int i = 0; i < 3; ++i)
        out[i] = (char)std::toupper((unsigned char)c[i]);
    out[3] = '\0';
    return true;
}

// Cache freshness decision, separating positive and negative (failure) TTLs so a
// transient enrichment failure retries soon instead of sticking for the full TTL.
enum class CacheAction { UseValid, SkipNegative, Fetch };

inline CacheAction cacheActionFor(bool found, bool valid, unsigned long ageMs,
                                  unsigned long positiveTtlMs, unsigned long negativeTtlMs)
{
    if (!found)
        return CacheAction::Fetch;
    if (valid)
        return ageMs < positiveTtlMs ? CacheAction::UseValid : CacheAction::Fetch;
    return ageMs < negativeTtlMs ? CacheAction::SkipNegative : CacheAction::Fetch;
}

// Enrichment cache key. The ROUTE belongs to the flight LEG, not to the airframe:
// a regional jet flies several legs a day, so keying on ICAO24 served the first
// leg's route until the TTL expired — and the TTL is user-configurable up to
// hours. The callsign changes with the leg, so it invalidates naturally. ICAO24
// is a defensive fallback, not a live path: every current caller (see
// FlightDataFetcher.cpp) already filters out empty callsigns before reaching
// here, so this keeps the helper correct standalone rather than handling a case
// that occurs today.
//
// Returns a pointer into one of the arguments; it does not copy.
inline const char *enrichmentCacheKey(const char *callsign, const char *icao24)
{
    if (callsign && callsign[0] != '\0')
        return callsign;
    return (icao24 && icao24[0] != '\0') ? icao24 : "";
}
