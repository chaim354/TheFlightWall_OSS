#pragma once
// Arduino-free, header-only brightness ladder. Host-testable (see test_buttons).
//
// WHY A LADDER AND NOT ARITHMETIC: the panel takes a LINEAR 0-255 via
// setBrightness8(), but perceived brightness is roughly logarithmic AND every value
// this device actually uses lives at the bottom of that range — the default is 20,
// the night schedule is 5, the light-sensor dim value is 3. A linear step of 16 goes
// 5 -> 21 -> 37 and blows past the entire useful band in three presses; a linear step
// of 1 needs 255 presses to cross it. Neither is usable.
//
// So the rungs are spaced roughly geometrically: fine near the bottom where the eye
// (and this wall) live, coarse at the top where nobody can tell 195 from 255. 15
// rungs crosses the whole range in ~2 seconds of holding at kRampRepeatMs.
//
// The ladder deliberately bottoms out at 1, never 0: "off" is a separate button
// action. A ramp that could reach 0 would leave a dark panel that looks broken and
// gives no feedback that the button worked.

#include <cstdint>
#include <cstddef>

static const uint8_t kBrightnessLadder[] = {
    1, 2, 3, 5, 8, 12, 18, 26, 38, 54, 76, 105, 145, 195, 255};
static const size_t kBrightnessLadderLen =
    sizeof(kBrightnessLadder) / sizeof(kBrightnessLadder[0]);

// Next rung strictly above `current`, saturating at the top. Handles values that are
// not themselves rungs (20 -> 26), which the real settings routinely are.
inline uint8_t brightnessUp(uint8_t current)
{
    for (size_t i = 0; i < kBrightnessLadderLen; ++i)
        if (kBrightnessLadder[i] > current)
            return kBrightnessLadder[i];
    return kBrightnessLadder[kBrightnessLadderLen - 1];
}

// Next rung strictly below `current`, saturating at 1 (never 0 — see above).
inline uint8_t brightnessDown(uint8_t current)
{
    uint8_t prev = kBrightnessLadder[0];
    for (size_t i = 0; i < kBrightnessLadderLen; ++i)
    {
        if (kBrightnessLadder[i] >= current)
            return prev;
        prev = kBrightnessLadder[i];
    }
    return kBrightnessLadder[kBrightnessLadderLen - 1];
}
