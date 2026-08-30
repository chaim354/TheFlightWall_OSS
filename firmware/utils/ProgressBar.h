#pragma once
// Arduino-free pure helper (host-testable). No String, no Arduino.h, no GFX.
#include <cmath>

// How many pixels of a `trackWidth`-wide bar represent `pct` percent flown.
//
// Extracted from Hub75Display::drawProgressBar for the same reason
// MetricRow.h and ServerJson.h were extracted from their call sites: the
// arithmetic has edge cases worth pinning, and pinning them inside a class
// that needs a GFX canvas and a panel means not pinning them at all.
//
// `pct` arrives from the wire. The server clamps it to 0-100 already
// (src/tracked/serve.ts), so everything below is about what happens when that
// promise is broken -- by a future server, a truncated JSON body, or a field
// that turns out to mean something else. A bar is 1px tall and nobody would
// notice it being subtly wrong, but a fill wider than its track writes past
// the canvas row, so the clamp is load-bearing rather than decorative.
inline int progressFillPixels(double pct, int trackWidth)
{
    if (trackWidth <= 0)
        return 0;
    // NAN and both infinities. NAN in particular fails every comparison below,
    // so it would slip through the clamp and reach the cast as undefined
    // behaviour rather than as a harmless zero.
    if (!std::isfinite(pct))
        return 0;

    if (pct <= 0.0)
        return 0;
    if (pct >= 100.0)
        return trackWidth;

    int filled = (int)((trackWidth * pct) / 100.0 + 0.5);

    // A flight that has genuinely left must never draw as an empty bar. On a
    // 126px track anything under 0.4% rounds to nothing, so the first half
    // hour of a 14-hour flight would render identically to "no progress data
    // at all" -- which is the single distinction this bar exists to make.
    if (filled < 1)
        filled = 1;
    // And one that is under way must not draw as complete: rounding at
    // 99.6% of a 126px track reaches 126, which reads as landed while the
    // aeroplane still has minutes to run.
    if (filled >= trackWidth)
        filled = trackWidth - 1;
    return filled;
}
