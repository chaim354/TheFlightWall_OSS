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
