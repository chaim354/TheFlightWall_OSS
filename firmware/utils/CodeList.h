#pragma once
// Arduino-free pure helper (host-testable). No String, no Arduino.h.
#include <cctype>
#include <cstddef>

// True for a 2- or 3-character operator code made only of letters and digits --
// the shape both airline lists are meant to hold, and the only shape that can
// travel in a query string without escaping.
//
// Anything else stays on the device: the local filter compares it
// case-insensitively and it simply never matches. It is never SENT to the
// server, where a stray "&" or "#" would cut the query string short and
// silently drop every parameter after it -- including the altitude band and
// the on-ground filter that share the same URL.
inline bool isPlainOperatorCode(const char *code)
{
    if (!code)
        return false;
    size_t n = 0;
    for (; code[n] != '\0'; ++n)
    {
        if (n >= 3)
            return false;
        if (!std::isalnum((unsigned char)code[n]))
            return false;
    }
    return n >= 2;
}
