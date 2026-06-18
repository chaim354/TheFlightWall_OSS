#pragma once

#include <Arduino.h>

namespace HardwareConfiguration
{
    // HUB75 RGB LED matrix pin mapping. Compile-time per target (panel geometry is
    // editable from the web UI). Change to match your board / breakout.
#if defined(CONFIG_IDF_TARGET_ESP32S3)
    // ESP32-S3-DevKitC-1 N16R8 map. Every pin exists on the S3 (GPIO 0-21, 26-48)
    // and AVOIDS: 26-32 (SPI flash), 33-37 (octal PSRAM), 0/3/45/46 (strapping),
    // 19/20 (native USB), 43/44 (UART0). Verify against your wiring.
    static const int8_t HUB75_R1 = 4;
    static const int8_t HUB75_G1 = 5;
    static const int8_t HUB75_B1 = 6;
    static const int8_t HUB75_R2 = 7;
    static const int8_t HUB75_G2 = 8;
    static const int8_t HUB75_B2 = 9;
    static const int8_t HUB75_A = 10;
    static const int8_t HUB75_B = 11;
    static const int8_t HUB75_C = 12;
    static const int8_t HUB75_D = 13;
    static const int8_t HUB75_E = 14;  // 1/32-scan (64-row) panels; set to -1 for 32-row
    static const int8_t HUB75_LAT = 15;
    static const int8_t HUB75_OE = 16;
    static const int8_t HUB75_CLK = 17;
#else
    // ESP32 (original) map — matches the common ESP32-HUB75-MatrixPanel-I2S-DMA wiring.
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
#endif

    // Default panel geometry (overridable at runtime from the web UI / Settings).
    static const uint16_t PANEL_RES_X = 64; // pixels wide per panel module
    static const uint16_t PANEL_RES_Y = 64; // pixels high per panel module
    static const uint8_t PANEL_CHAIN = 2;   // number of panels chained -> 128x64 total
}
