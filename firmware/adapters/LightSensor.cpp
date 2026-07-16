/*
Purpose: Implementation of the ambient light sensor (see LightSensor.h).
*/
#include "adapters/LightSensor.h"
#include "core/Settings.h"
#include "config/HardwareConfiguration.h"

#include <Wire.h>

static const uint8_t kBH1750Addr = 0x23;
static const uint8_t kBH1750PowerOn = 0x01;
static const uint8_t kBH1750ContHighRes = 0x10; // continuous 1 lx resolution

// ---- TCS3472 (TCS34725/27) ------------------------------------------------
// Every register access must OR in the COMMAND bit; 0xA0 additionally selects
// auto-increment, which is what makes the 16-bit CDATA pair readable in one go.
static const uint8_t kTcsAddr = 0x29;
static const uint8_t kTcsCmd = 0x80;
static const uint8_t kTcsCmdAutoInc = 0xA0;
static const uint8_t kTcsRegEnable = 0x00;
static const uint8_t kTcsRegAtime = 0x01;
static const uint8_t kTcsRegId = 0x12;
static const uint8_t kTcsRegControl = 0x0F;
static const uint8_t kTcsRegCData = 0x14; // Clear channel, low byte first
static const uint8_t kTcsEnablePon = 0x01;
static const uint8_t kTcsEnableAen = 0x02;
static const uint8_t kTcsIdPart1 = 0x44; // TCS34725
static const uint8_t kTcsIdPart2 = 0x4D; // TCS34727
// 154ms integration (ATIME = 256 - 154/2.4 = 0xC0) gives the full 16-bit range
// (64 cycles x 1024 = 65536, clipped to 65535). 16x gain deliberately saturates in a
// lit room: saturated still reads "not dark", so the range is better spent on
// resolution at the dark end, where the decision is actually close. Both are single
// constants — retune here if the threshold ends up cramped.
static const uint8_t kTcsAtime154ms = 0xC0;
static const uint8_t kTcsGain16x = 0x02;

static bool tcsWrite(uint8_t reg, uint8_t value)
{
    Wire.beginTransmission(kTcsAddr);
    Wire.write(kTcsCmd | reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

static bool tcsRead8(uint8_t reg, uint8_t &out)
{
    Wire.beginTransmission(kTcsAddr);
    Wire.write(kTcsCmd | reg);
    if (Wire.endTransmission() != 0)
        return false;
    if (Wire.requestFrom((int)kTcsAddr, 1) != 1)
        return false;
    out = Wire.read();
    return true;
}

// True only for an ADC1 pin on THIS target. ADC2 is unusable while WiFi is up, and on
// the S3 the classic 32-39 range lands on SPI flash / octal PSRAM — so an unchecked
// pin from the web UI could point analogRead() at a live PSRAM line. Range-checking
// keeps a bad setting inert instead of hazardous.
static bool isValidAdc1Pin(uint8_t pin)
{
    return pin >= HardwareConfiguration::ADC1_PIN_MIN && pin <= HardwareConfiguration::ADC1_PIN_MAX;
}

void LightSensor::begin()
{
    _dark = false;
    _last = -1;
    _i2cReady = false;
    _analogReady = false;

    if (!g_settings.lightSensorEnabled)
        return;

    switch (g_settings.lightSensorType)
    {
    case LightSensorType::BH1750:
        Wire.begin(HardwareConfiguration::I2C_SDA, HardwareConfiguration::I2C_SCL);
        Wire.beginTransmission(kBH1750Addr);
        Wire.write(kBH1750PowerOn);
        if (Wire.endTransmission() == 0)
        {
            Wire.beginTransmission(kBH1750Addr);
            Wire.write(kBH1750ContHighRes);
            _i2cReady = (Wire.endTransmission() == 0);
        }
        if (!_i2cReady)
            Serial.printf("LightSensor: BH1750 not found on I2C (SDA=%d, SCL=%d)\n",
                          (int)HardwareConfiguration::I2C_SDA, (int)HardwareConfiguration::I2C_SCL);
        break;

    case LightSensorType::TCS3472:
    {
        Wire.begin(HardwareConfiguration::I2C_SDA, HardwareConfiguration::I2C_SCL);
        // ID check first: without it an absent/miswired sensor reads 0 and update()
        // would call a pitch-black room, blanking the panel. A failed ID leaves
        // _i2cReady false, which fails safe to "lit".
        uint8_t id = 0;
        if (!tcsRead8(kTcsRegId, id) || (id != kTcsIdPart1 && id != kTcsIdPart2))
        {
            Serial.printf("LightSensor: TCS3472 not found on I2C (SDA=%d, SCL=%d), id=0x%02X\n",
                          (int)HardwareConfiguration::I2C_SDA, (int)HardwareConfiguration::I2C_SCL,
                          (unsigned)id);
            break;
        }
        // PON must settle before AEN is allowed (2.4ms per the datasheet; 3 to spare).
        bool ok = tcsWrite(kTcsRegEnable, kTcsEnablePon);
        delay(3);
        ok = ok && tcsWrite(kTcsRegAtime, kTcsAtime154ms);
        ok = ok && tcsWrite(kTcsRegControl, kTcsGain16x);
        ok = ok && tcsWrite(kTcsRegEnable, kTcsEnablePon | kTcsEnableAen);
        _i2cReady = ok;
        if (!ok)
            Serial.println("LightSensor: TCS3472 found but failed to configure");
        break;
    }

    case LightSensorType::Analog:
        if (!isValidAdc1Pin(g_settings.lightSensorPin))
        {
            Serial.printf("LightSensor: pin %u is not ADC1 on this board (valid %u-%u); "
                          "analog sensor disabled\n",
                          (unsigned)g_settings.lightSensorPin,
                          (unsigned)HardwareConfiguration::ADC1_PIN_MIN,
                          (unsigned)HardwareConfiguration::ADC1_PIN_MAX);
            break;
        }
        // ADC1 only (WiFi disables ADC2). 11dB attenuation -> ~full 3.3V range.
        analogReadResolution(12);
        analogSetPinAttenuation(g_settings.lightSensorPin, ADC_11db);
        _analogReady = true;
        break;
    }
}

int LightSensor::readSensor()
{
    switch (g_settings.lightSensorType)
    {
    case LightSensorType::BH1750:
        if (!_i2cReady)
            return -1;
        if (Wire.requestFrom((int)kBH1750Addr, 2) != 2)
            return -1;
        {
            uint16_t raw = ((uint16_t)Wire.read() << 8) | Wire.read();
            return (int)(raw / 1.2f); // lux
        }

    case LightSensorType::TCS3472:
        if (!_i2cReady)
            return -1;
        // Auto-increment across CDATAL/CDATAH; the part is little-endian here.
        Wire.beginTransmission(kTcsAddr);
        Wire.write(kTcsCmdAutoInc | kTcsRegCData);
        if (Wire.endTransmission() != 0)
            return -1;
        if (Wire.requestFrom((int)kTcsAddr, 2) != 2)
            return -1;
        {
            uint8_t lo = Wire.read();
            uint8_t hi = Wire.read();
            return (int)(((uint16_t)hi << 8) | lo); // raw Clear, higher = brighter
        }

    case LightSensorType::Analog:
        if (!_analogReady)
            return -1; // pin failed validation -> fail safe to "lit"
        return analogRead(g_settings.lightSensorPin); // 0..4095, higher = brighter
    }
    return -1;
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
