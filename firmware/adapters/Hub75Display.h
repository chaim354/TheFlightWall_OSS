#pragma once

#include <stdint.h>
#include <vector>
#include "interfaces/BaseDisplay.h"

class MatrixPanel_I2S_DMA;
class GFXcanvas16;

// Drives a HUB75 RGB LED matrix via ESP32-HUB75-MatrixPanel-I2S-DMA.
//
// Every frame is composed into an in-RAM GFXcanvas16 (RGB565), then blitted to
// the panel. That same canvas buffer is exposed via framebuffer() so the web UI
// can render a live preview of exactly what's on the wall.
class Hub75Display : public BaseDisplay
{
public:
    Hub75Display();
    ~Hub75Display() override;

    bool initialize() override;
    void clear() override;
    void displayFlights(const std::vector<FlightInfo> &flights) override;
    void displayMessage(const String &message);
    void showLoading();

    void setBrightness(uint8_t brightness);
    const uint16_t *framebuffer(uint16_t &w, uint16_t &h) const override;

private:
    MatrixPanel_I2S_DMA *_panel = nullptr;
    GFXcanvas16 *_canvas = nullptr;

    uint16_t _matrixWidth = 0;
    uint16_t _matrixHeight = 0;

    size_t _currentFlightIndex = 0;
    unsigned long _lastCycleMs = 0;

    // Single-entry logo cache (loaded from /logos/<ICAO>.rgb565 on LittleFS).
    String _logoIcao;
    uint16_t *_logoPixels = nullptr;
    int _logoW = 0;
    int _logoH = 0;
    bool _logoValid = false;

    void present(); // blit the canvas to the panel

    void drawTextLine(int16_t x, int16_t y, const String &text, uint16_t color);
    String truncateToColumns(const String &text, int maxColumns);
    void buildFlightLines(const FlightInfo &f, std::vector<String> &outLines, bool includeAirline);
    void displayFlightCard(const FlightInfo &f);     // picks a layout by panel shape
    void displaySideBySideCard(const FlightInfo &f); // wide panels: logo left, text right
    void displayStackedCard(const FlightInfo &f);    // square/tall panels: logo top, text below
    void displayTextOnlyCard(const FlightInfo &f);   // very short panels: bordered text
    void displayLoadingScreen();
    uint16_t textColor();

    bool loadLogoFor(const String &icao);
    uint16_t accentColorFor(const String &code);
    void drawLogoOrBadge(const FlightInfo &f, int16_t x, int16_t y, int16_t w, int16_t h, uint8_t scale = 1);
    int16_t fitLines(std::vector<String> &lines, int maxCols, int availHeight);
};
