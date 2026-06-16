#pragma once

#include <Arduino.h>

namespace HardwareConfiguration
{
    // HUB75 RGB LED matrix pin mapping (ESP32). These match the common default
    // wiring used by the ESP32-HUB75-MatrixPanel-I2S-DMA library. Change to match
    // your board / breakout. (These are the only pin assignments that are
    // compile-time; panel geometry is editable from the web UI.)
    static const int8_t HUB75_R1 = 25;
    static const int8_t HUB75_G1 = 26;
    static const int8_t HUB75_B1 = 27;
    static const int8_t HUB75_R2 = 14;
    static const int8_t HUB75_G2 = 12;
    static const int8_t HUB75_B2 = 13;
    static const int8_t HUB75_A = 23;
    static const int8_t HUB75_B = 19;
    static const int8_t HUB75_C = 5;
    static const int8_t HUB75_D = 17;
    static const int8_t HUB75_E = 32;  // needed for 1/32-scan (64-row) panels; set to -1 for 32-row
    static const int8_t HUB75_LAT = 4;
    static const int8_t HUB75_OE = 15;
    static const int8_t HUB75_CLK = 16;

    // Default panel geometry (overridable at runtime from the web UI / Settings).
    static const uint16_t PANEL_RES_X = 64; // pixels wide per panel module
    static const uint16_t PANEL_RES_Y = 64; // pixels high per panel module
    static const uint8_t PANEL_CHAIN = 2;   // number of panels chained -> 128x64 total
}
