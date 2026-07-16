#pragma once

#include <stdint.h>
#include <vector>
#include "interfaces/BaseDisplay.h"
#include "utils/LruCache.h"

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
    void displaySplash(); // branded boot screen: wordmark + plane glyph + tagline
    void showLoading();

    // Call right after a fresh flight list is fetched/assigned. Bumps the data
    // version so the next displayFlights() recomposes the canvas even if the
    // cycled index hasn't changed. The 200ms re-render path does NOT call this,
    // so it only recomposes when the cycle advances.
    void markFlightsUpdated();

    void setBrightness(uint8_t brightness);
    const uint16_t *framebuffer(uint16_t &w, uint16_t &h) const override;

private:
    MatrixPanel_I2S_DMA *_panel = nullptr;
    GFXcanvas16 *_canvas = nullptr;

    uint16_t _matrixWidth = 0;
    uint16_t _matrixHeight = 0;

    size_t _currentFlightIndex = 0;
    unsigned long _lastCycleMs = 0;

    // Dirty-check gating so we only recompose the canvas when the displayed card
    // actually changes (cycle advance or new data), not on every 200ms poll.
    // _dataVersion starts at 1 and _lastComposedVersion at 0 so the first render
    // after boot always composes. SIZE_MAX is the "empty list" sentinel index.
    uint32_t _dataVersion = 1;
    uint32_t _lastComposedVersion = 0;
    size_t _lastComposedIndex = SIZE_MAX;

    // For the animated no-flights modes (clock/funfact/clockfact), the displayed
    // index stays SIZE_MAX so the dirty-check above would never recompose. We
    // track a per-mode "frame key" (current minute for the clock, fact index for
    // fun facts) and force a recompose when it changes so the screen ticks.
    long _lastNoFlightsKey = -1;

    // Decoded logo tiles (from /logos/<key>.rgb565 on LittleFS), keyed by the
    // logo key (operator ICAO or a "_HELI"/"_PRIVATE"/"_CARGO" pseudo-key).
    struct LogoTile
    {
        uint16_t w = 0;           // w==0 marks a KNOWN-MISSING tile (negative cache)
        uint16_t h = 0;
        std::vector<uint16_t> px; // RAII: eviction frees automatically
    };
    // 4 tiles ~= 8KB held once, instead of a 2KB malloc/free on every recompose.
    // A fixed pool is also kinder to fragmentation than repeated alloc/free.
    // Capacity 4 also lets a missing operator key and the _CARGO fallback coexist,
    // so a cargo flight with no operator tile stops re-hitting LittleFS every frame.
    LruCache<String, LogoTile> _logoCache{4};

    // Whether the last drawLogoOrBadge() painted a real tile (vs. the code badge).
    // displayMiniCard() uses it to drop the redundant "Airlines/Airways" suffix.
    bool _lastDrewLogo = false;

    void present(); // blit the canvas to the panel

    void drawTextLine(int16_t x, int16_t y, const String &text, uint16_t color);
    String truncateToColumns(const String &text, int maxColumns);
    void buildFlightLines(const FlightInfo &f, std::vector<String> &outLines, bool includeAirline);
    void displayFlightCard(const FlightInfo &f);     // picks a layout by panel shape
    void displayMiniCard(const FlightInfo &f);       // big panels (128x64): logo + info + metric rows
    void displaySideBySideCard(const FlightInfo &f); // wide panels: logo left, text right
    void displayStackedCard(const FlightInfo &f);    // square/tall panels: logo top, text below
    void displayTextOnlyCard(const FlightInfo &f);   // very short panels: bordered text
    void displayLoadingScreen();
    void displayNoFlights();                                 // dispatches by g_settings.layout.noFlightsMode
    void drawClockScreen();                                  // large HH:MM + date line
    void drawFunFactScreen();                                // rotating word-wrapped fun fact
    long noFlightsFrameKey();                                // recompose key for the active animated mode
    uint16_t textColor();

    // Cache-or-load the tile for `key`. Returns nullptr only if `key` is empty;
    // otherwise the returned tile may be a negative entry (w==0 == "no tile").
    // The pointer is valid until the next tileFor() call.
    const LogoTile *tileFor(const String &key);
    uint16_t accentColorFor(const String &code);
    // Draws the logo (auto-fit to the box by integer scale) or a code badge fallback.
    void drawLogoOrBadge(const FlightInfo &f, int16_t x, int16_t y, int16_t w, int16_t h);
    int16_t fitLines(std::vector<String> &lines, int maxCols, int availHeight);
};
