/*
Purpose: Ambient light sensor for auto-off / dimming the panel when the room is
dark. Supports two sensor types (selected in Settings):
  - Analog photoresistor/LDR on an ADC1 pin (ADC1 is required because ADC2 is
    unavailable while WiFi is active).
  - I2C BH1750 lux sensor on SDA=21 / SCL=22 (no extra library; minimal driver).

update() reads the sensor and applies a hysteresis band so the panel doesn't
flicker around the threshold; isDark() reports the debounced state. A failed /
absent sensor reports "not dark" (fail-safe: the panel stays on).
*/
#pragma once

#include <Arduino.h>

class LightSensor
{
public:
    void begin();   // (re)initialize for the current Settings (call after changes)
    void update();  // sample the sensor + update the dark/lit state (hysteresis)
    bool isDark() const { return _dark; }
    int level() const { return _last; } // last raw reading (0-4095 analog, or lux), -1 if none

private:
    bool _dark = false;
    int _last = -1;
    bool _i2cReady = false;

    int readSensor();
};
