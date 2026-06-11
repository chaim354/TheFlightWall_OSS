/*
Purpose: Implementation of the ambient light sensor (see LightSensor.h).
*/
#include "adapters/LightSensor.h"
#include "core/Settings.h"

#include <Wire.h>

static const uint8_t kBH1750Addr = 0x23;
static const uint8_t kBH1750PowerOn = 0x01;
static const uint8_t kBH1750ContHighRes = 0x10; // continuous 1 lx resolution
static const int8_t kI2cSda = 21;
static const int8_t kI2cScl = 22;

void LightSensor::begin()
{
    _dark = false;
    _last = -1;
    _i2cReady = false;

    if (!g_settings.lightSensorEnabled)
        return;

    if (g_settings.lightSensorType == LightSensorType::BH1750)
    {
        Wire.begin(kI2cSda, kI2cScl);
        Wire.beginTransmission(kBH1750Addr);
        Wire.write(kBH1750PowerOn);
        if (Wire.endTransmission() == 0)
        {
            Wire.beginTransmission(kBH1750Addr);
            Wire.write(kBH1750ContHighRes);
            _i2cReady = (Wire.endTransmission() == 0);
        }
        if (!_i2cReady)
            Serial.println("LightSensor: BH1750 not found on I2C (SDA=21, SCL=22)");
    }
    else
    {
        // Analog: ADC1 pins only (WiFi disables ADC2). 11dB attenuation -> ~full 3.3V range.
        analogReadResolution(12);
        analogSetPinAttenuation(g_settings.lightSensorPin, ADC_11db);
    }
}

int LightSensor::readSensor()
{
    if (g_settings.lightSensorType == LightSensorType::BH1750)
    {
        if (!_i2cReady)
            return -1;
        if (Wire.requestFrom((int)kBH1750Addr, 2) != 2)
            return -1;
        uint16_t raw = ((uint16_t)Wire.read() << 8) | Wire.read();
        return (int)(raw / 1.2f); // lux
    }
    return analogRead(g_settings.lightSensorPin); // 0..4095, higher = brighter
}

void LightSensor::update()
{
    if (!g_settings.lightSensorEnabled)
    {
        _dark = false;
        return;
    }

    int v = readSensor();
    if (v < 0)
    {
        // Sensor missing/broken -> fail safe to "lit" so the panel never gets
        // stuck dark.
        _last = -1;
        _dark = false;
        return;
    }
    _last = v;

    const int thr = (int)g_settings.lightDarkThreshold;
    const int hys = (int)g_settings.lightHysteresis;
    if (!_dark && v < thr)
        _dark = true;
    else if (_dark && v > (thr + hys))
        _dark = false;
}
