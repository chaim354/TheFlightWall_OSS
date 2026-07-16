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

    // ---- Ambient light sensor -------------------------------------------------
    // Board-guarded for the same reason the HUB75 map above is: the ESP32 values are
    // physically wrong on the S3, silently.
#if defined(CONFIG_IDF_TARGET_ESP32S3)
    // The S3 has NO GPIO 22-25 (it goes 0-21, then 26-48), so the classic ESP32's
    // SDA=21/SCL=22 cannot work here. 41/42 are plain digital pins clear of HUB75
    // (4-17), SPI flash (26-32), octal PSRAM (33-37), native USB (19/20 — the Serial
    // console, see platformio.ini), UART0 (43/44) and the strapping pins (0/3/45/46).
    static const int8_t I2C_SDA = 41;
    static const int8_t I2C_SCL = 42;
    // ADC1 on the S3 is GPIO 1-10 — NOT 32-39. Worse, 33-37 are the octal PSRAM on an
    // N16R8, so the classic default of 34 would point analogRead() at a live PSRAM
    // pin. HUB75 already owns 4-17, leaving 1/2/3; 3 is a strapping pin, so 1 it is.
    static const uint8_t LIGHT_ANALOG_PIN = 1;
    static const uint8_t ADC1_PIN_MIN = 1;
    static const uint8_t ADC1_PIN_MAX = 10;
#else
    static const int8_t I2C_SDA = 21;
    static const int8_t I2C_SCL = 22;
    static const uint8_t LIGHT_ANALOG_PIN = 34; // ADC1: 32-39 (ADC2 is unusable with WiFi)
    static const uint8_t ADC1_PIN_MIN = 32;
    static const uint8_t ADC1_PIN_MAX = 39;
#endif

    // Default panel geometry (overridable at runtime from the web UI / Settings).
    static const uint16_t PANEL_RES_X = 64; // pixels wide per panel module
    static const uint16_t PANEL_RES_Y = 64; // pixels high per panel module
    static const uint8_t PANEL_CHAIN = 2;   // number of panels chained -> 128x64 total
}
