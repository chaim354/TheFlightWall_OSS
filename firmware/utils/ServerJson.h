#pragma once
// Arduino-free pure helpers (host-testable). No String, no Arduino.h, no ArduinoJson.
#include <cmath>

// Absent means UNKNOWN, and unknown must render blank — never as a number.
//
// ArduinoJson's `doc["alt"] | 0` idiom is wrong for this contract: it turns a
// missing altitude into sea level, a missing speed into stationary, and a
// missing vertical rate into level flight. All three are readings a viewer
// would believe. NAN is the value the display code already treats as
// "do not print" (see formatAltitude / formatHeading), so mapping absence to
// NAN makes every existing consumer do the right thing with no changes.
//
// Zero is deliberately a REAL value: an aircraft on the ground at sea level
// legitimately reports 0 ft, and one in level flight legitimately reports 0 fpm.
inline double optionalNumber(bool present, double value)
{
    if (!present || !std::isfinite(value))
        return NAN;
    return value;
}

// What a renderer should ask before printing. Rejects NAN and both infinities —
// a garbage value on the wire must not reach the panel as "inf".
inline bool renderable(double v)
{
    return std::isfinite(v);
}
