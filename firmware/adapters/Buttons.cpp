/*
Purpose: Implementation of the two physical buttons (see Buttons.h).
*/
#include "adapters/Buttons.h"
#include "core/Settings.h"
#include "config/HardwareConfiguration.h"

void Buttons::begin()
{
    _ready = g_settings.buttonsEnabled;
    if (!_ready)
        return;
    // INPUT_PULLUP + button to GND: released reads HIGH, pressed reads LOW.
    pinMode(HardwareConfiguration::BUTTON_A_PIN, INPUT_PULLUP);
    pinMode(HardwareConfiguration::BUTTON_B_PIN, INPUT_PULLUP);

    // The optional EXTERNAL pair, in parallel with the onboard one. A pin below
    // zero means this board has none -- pinMode(-1) is not a no-op, it indexes
    // a GPIO table out of range, so the guard is load-bearing rather than tidy.
    if (HardwareConfiguration::BUTTON_A_EXT_PIN >= 0)
        pinMode(HardwareConfiguration::BUTTON_A_EXT_PIN, INPUT_PULLUP);
    if (HardwareConfiguration::BUTTON_B_EXT_PIN >= 0)
        pinMode(HardwareConfiguration::BUTTON_B_EXT_PIN, INPUT_PULLUP);

    if (HardwareConfiguration::BUTTON_A_EXT_PIN >= 0 ||
        HardwareConfiguration::BUTTON_B_EXT_PIN >= 0)
        Serial.printf("[buttons] enabled on GPIO %d (A) and %d (B), "
                      "external %d (A) and %d (B)\n",
                      (int)HardwareConfiguration::BUTTON_A_PIN,
                      (int)HardwareConfiguration::BUTTON_B_PIN,
                      (int)HardwareConfiguration::BUTTON_A_EXT_PIN,
                      (int)HardwareConfiguration::BUTTON_B_EXT_PIN);
    else
        Serial.printf("[buttons] enabled on GPIO %d (A) and %d (B)\n",
                      (int)HardwareConfiguration::BUTTON_A_PIN,
                      (int)HardwareConfiguration::BUTTON_B_PIN);
}

ButtonEvents Buttons::poll(unsigned long nowMs)
{
    ButtonEvents out;
    if (!_ready)
        return out;

    // OR the pairs together: either switch pressing is the action pressed. The
    // debounce/ramp state machine below then sees ONE logical button, so an
    // external press behaves identically to an onboard one -- including long
    // holds -- and holding both is the same as holding either.
    //
    // An absent external pin is never read; digitalRead(-1) would sample
    // whatever that out-of-range index lands on, which is a phantom press
    // waiting to happen on the two boards that declare no external pair.
    const bool aDown =
        digitalRead(HardwareConfiguration::BUTTON_A_PIN) == LOW ||
        (HardwareConfiguration::BUTTON_A_EXT_PIN >= 0 &&
         digitalRead(HardwareConfiguration::BUTTON_A_EXT_PIN) == LOW);
    const bool bDown =
        digitalRead(HardwareConfiguration::BUTTON_B_PIN) == LOW ||
        (HardwareConfiguration::BUTTON_B_EXT_PIN >= 0 &&
         digitalRead(HardwareConfiguration::BUTTON_B_EXT_PIN) == LOW);

    const ButtonState::Event ea = _a.update(aDown, nowMs);
    const ButtonState::Event eb = _b.update(bDown, nowMs);

    out.clickA = (ea == ButtonState::Event::Click);
    out.rampA = (ea == ButtonState::Event::Ramp);
    out.clickB = (eb == ButtonState::Event::Click);
    out.rampB = (eb == ButtonState::Event::Ramp);
    return out;
}
