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
    _ready = false;

    if (!g_settings.lightSensorEnabled)
        return;

    // Latch the configuration being brought up. Everything below validates and
    // configures THESE, and readSensor() samples THESE -- never the live
    // Settings, which can move underneath us between calls.
    _type = g_settings.lightSensorType;
    _pin = g_settings.lightSensorPin;

    switch (_type)
    {
    case LightSensorType::BH1750:
        Wire.begin(HardwareConfiguration::I2C_SDA, HardwareConfiguration::I2C_SCL);
        Wire.beginTransmission(kBH1750Addr);
        Wire.write(kBH1750PowerOn);
        if (Wire.endTransmission() == 0)
        {
            Wire.beginTransmission(kBH1750Addr);
            Wire.write(kBH1750ContHighRes);
            _ready = (Wire.endTransmission() == 0);
        }
        if (!_ready)
            Serial.printf("LightSensor: BH1750 not found on I2C (SDA=%d, SCL=%d)\n",
                          (int)HardwareConfiguration::I2C_SDA, (int)HardwareConfiguration::I2C_SCL);
        break;

    case LightSensorType::TCS3472:
    {
        Wire.begin(HardwareConfiguration::I2C_SDA, HardwareConfiguration::I2C_SCL);
        // ID check first: without it an absent/miswired sensor reads 0 and update()
        // would call a pitch-black room, blanking the panel. A failed ID leaves
        // _ready false, which fails safe to "lit".
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
        _ready = ok;
        if (!ok)
            Serial.println("LightSensor: TCS3472 found but failed to configure");
        break;
    }

    case LightSensorType::Analog:
        // Cross-check against the buttons. On the classic ESP32 the free-pin budget is
        // so thin that BUTTON_B lands on 33 — a legitimate ADC1 pin — so this
        // collision is reachable straight from the web UI. Two subsystems silently
        // fighting over one pin is exactly the bug that produced the 18/21 mistake;
        // say so out loud instead of letting it be debugged twice.
        if (g_settings.buttonsEnabled &&
            (_pin == (uint8_t)HardwareConfiguration::BUTTON_A_PIN ||
             _pin == (uint8_t)HardwareConfiguration::BUTTON_B_PIN))
        {
            Serial.printf("LightSensor: pin %u is already a button (A=%d, B=%d); "
                          "analog sensor disabled. Disable buttons or pick another pin.\n",
                          (unsigned)_pin,
                          (int)HardwareConfiguration::BUTTON_A_PIN,
                          (int)HardwareConfiguration::BUTTON_B_PIN);
            break;
        }
        if (!isValidAdc1Pin(_pin))
        {
            Serial.printf("LightSensor: pin %u is not ADC1 on this board (valid %u-%u); "
                          "analog sensor disabled\n",
                          (unsigned)_pin,
                          (unsigned)HardwareConfiguration::ADC1_PIN_MIN,
                          (unsigned)HardwareConfiguration::ADC1_PIN_MAX);
            break;
        }
        // ADC1 only (WiFi disables ADC2). 11dB attenuation -> ~full 3.3V range.
        analogReadResolution(12);
        analogSetPinAttenuation(_pin, ADC_11db);
        _ready = true;
        break;
    }
}

int LightSensor::readSensor()
{
    // ONE readiness gate, and it asks the right question: is the configuration
    // begin() validated still the configuration Settings wants? If Settings has
    // moved on and nothing re-ran begin(), we are not ready for the new one --
    // fail safe to "lit" rather than sampling something unvalidated. Note this
    // deliberately does NOT compare the pin: begin() validated _pin, so reading
    // it stays safe, and a pin change without a re-begin self-heals as soon as
    // one happens. Thresholds are still read live in update() -- that is the
    // documented `light watch` tuning loop and must not become latched state.
    if (!_ready || _type != g_settings.lightSensorType)
        return -1;

    switch (_type)
    {
    case LightSensorType::BH1750:
        if (Wire.requestFrom((int)kBH1750Addr, 2) != 2)
            return -1;
        {
            uint16_t raw = ((uint16_t)Wire.read() << 8) | Wire.read();
            return (int)(raw / 1.2f); // lux
        }

    case LightSensorType::TCS3472:
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
        return analogRead(_pin); // the pin begin() validated; 0..4095, higher = brighter
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
