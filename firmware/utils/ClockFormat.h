#pragma once
// Arduino-free, header-only 12-hour clock formatting. Host-testable (test_clock).
//
// Kept out of Hub75Display so the two boundary cases can be tested without a panel:
// hour 0 renders as "12 AM" (a naive hour%12 gives "0"), and hour 12 renders as
// "12 PM" (naive code often gives "0 PM", or flips to AM an hour early).

#include <cstdio>
#include <cstddef>

// 24-hour hour+minute -> "3:45 PM". No leading zero on the hour, always one on the
// minute. Longest output is "12:00 AM" — 8 chars + NUL, so `out` needs >= 9 bytes.
inline void formatClock12(int hour24, int minute, char *out, size_t outLen)
{
    int h = hour24 % 12;
    if (h == 0)
        h = 12; // midnight and noon are both "12", not "0"
    snprintf(out, outLen, "%d:%02d %s", h, minute, hour24 < 12 ? "AM" : "PM");
}
