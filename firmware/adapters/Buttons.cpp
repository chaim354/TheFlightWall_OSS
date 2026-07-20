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
    Serial.printf("[buttons] enabled on GPIO %d (A) and %d (B)\n",
                  (int)HardwareConfiguration::BUTTON_A_PIN,
                  (int)HardwareConfiguration::BUTTON_B_PIN);
}

ButtonEvents Buttons::poll(unsigned long nowMs)
{
    ButtonEvents out;
    if (!_ready)
        return out;

    const bool aDown = digitalRead(HardwareConfiguration::BUTTON_A_PIN) == LOW;
    const bool bDown = digitalRead(HardwareConfiguration::BUTTON_B_PIN) == LOW;

    const ButtonState::Event ea = _a.update(aDown, nowMs);
    const ButtonState::Event eb = _b.update(bDown, nowMs);

    out.clickA = (ea == ButtonState::Event::Click);
    out.rampA = (ea == ButtonState::Event::Ramp);
    out.clickB = (eb == ButtonState::Event::Click);
    out.rampB = (eb == ButtonState::Event::Ramp);
    return out;
}
