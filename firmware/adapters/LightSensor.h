/*
Purpose: Ambient light sensor for auto-off / dimming the panel when the room is
dark. Supports three sensor types (selected in Settings); both I2C parts use the
board-guarded HardwareConfiguration::I2C_SDA / I2C_SCL pins, and neither needs an
extra library (minimal drivers):
  - Analog photoresistor/LDR on an ADC1 pin (ADC1 is required because ADC2 is
    unavailable while WiFi is active). The pin is range-checked per board.
  - I2C BH1750 lux sensor        -> reading is lux.
  - I2C TCS3472 (TCS34725/27)    -> reading is the raw Clear channel.

IMPORTANT: level() and lightDarkThreshold are in the SELECTED SENSOR'S units, and
the three scales are not interchangeable. Tune the threshold against the live
`lightLevel` in /api/status, not by reasoning about the number.

update() reads the sensor and applies a hysteresis band so the panel doesn't
flicker around the threshold; isDark() reports the debounced state. A failed /
absent sensor reports "not dark" (fail-safe: the panel stays on) — which is why
the TCS3472 path checks the chip ID: a missing part reads 0, and 0 would otherwise
look like a pitch-black room and blank the panel.
*/
#pragma once

#include <Arduino.h>

// Opaque-enum declaration rather than including core/Settings.h -- no header in
// this tree includes it, and this is legal (and gives a complete type usable as
// a member) because the underlying type is fixed where the enum is defined.
enum class LightSensorType : uint8_t;

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

    // WHAT begin() ACTUALLY BROUGHT UP -- not what Settings currently says.
    // These used to be two bare bools, so readiness certified a configuration
    // the object did not store: readSensor() dispatched on the LIVE
    // g_settings.lightSensorType and sampled the LIVE g_settings.lightSensorPin
    // while guarded only by a flag meaning "some pin, once, passed validation".
    // Change the pin without re-running begin() (the serial console had no
    // settings-changed signal) and analogRead() would sample an unvalidated pin,
    // which reads 0, which is not < 0, so update()'s fail-safe was skipped and
    // the panel latched dark permanently. Storing the configuration is what
    // makes that state unrepresentable.
    bool _ready = false;
    LightSensorType _type{};
    uint8_t _pin = 0;

    int readSensor();
};
