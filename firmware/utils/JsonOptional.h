#pragma once
// ArduinoJson-aware optional readers.
//
// Separate from utils/ServerJson.h on purpose: that file's banner declares "No
// String, no Arduino.h, no ArduinoJson", and test_serverjson.cpp compiles under
// bare g++ with ArduinoJson nowhere on the include path. The DECISION logic --
// what counts as present, the finite clamp, "zero is a real value" -- stays
// there and stays host-tested; only the ArduinoJson plumbing lives here.
#include <ArduinoJson.h>
#include "ServerJson.h"

// Optional numeric field -> value-or-NAN.
//
// ArduinoJson's `o[key] | 0` idiom is wrong for this contract: it turns a
// missing altitude into sea level, a missing speed into stationary and a
// missing vertical rate into level flight -- three readings a viewer would
// believe. The type check matters too, and for the same reason: a wrong-typed
// value degrades to unknown rather than arriving through a different, less
// obvious door.
//
// `is<float>()` alone is sufficient -- it is already false for null -- so the
// `!v.isNull() &&` that both copies of this carried was redundant.
inline double optNum(JsonObject o, const char *key)
{
    JsonVariant v = o[key];
    const bool present = v.is<float>();
    return optionalNumber(present, present ? v.as<double>() : NAN);
}

// Same contract for array-indexed feeds.
//
// OpenSky and Flightradar24 read positionally (`a[7]`), not by key, which is why
// they still hand-roll `a[i].isNull() ? NAN : a[i].as<double>()` at 13 sites --
// an idiom with no type check at all. This is the overload those sites need.
//
// NOT yet migrated: a numeric JSON STRING parses under the old idiom and would
// become NAN under this one. FR24's feed is an undocumented scraped array, so
// that has to be checked against a live capture rather than by reading.
inline double optNum(JsonVariant v)
{
    const bool present = v.is<float>();
    return optionalNumber(present, present ? v.as<double>() : NAN);
}
