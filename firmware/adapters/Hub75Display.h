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
// the panel in one pass, so a partially-drawn card is never visible.
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

    // Re-read the settings this display caches decisions from. Call after Settings
    // load and whenever they change at runtime (maxFlights is editable from the web
    // UI, and the logo pool is sized from it).
    void applySettings();

    // Briefly overlay a line of text on whatever is on screen. Used by the mode
    // button: noFlightsMode only renders when the sky is EMPTY, so pressing it while
    // flights are up changes a setting you cannot see change — which reads as a
    // broken button. The toast is the acknowledgement.
    void showToast(const String &text, unsigned long durationMs = 2000);

    void setBrightness(uint8_t brightness);

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

    // Transient overlay (see showToast). _toastUntilMs == 0 means inactive.
    String _toastText;
    unsigned long _toastUntilMs = 0;
    void drawToastIfActive();

    // Decoded logo tiles (from /logos/<key>.rgb565 on LittleFS), keyed by the
    // logo key (operator ICAO or a "_HELI"/"_PRIVATE"/"_CARGO" pseudo-key).
    struct LogoTile
    {
        uint16_t w = 0;           // w==0 marks a KNOWN-MISSING tile (negative cache)
        uint16_t h = 0;
        std::vector<uint16_t> px; // RAII: eviction frees automatically
    };
    // ~2KB per tile, held once instead of a malloc/free on every recompose; a fixed
    // pool is also kinder to fragmentation than repeated alloc/free.
    //
    // Capacity MUST cover the working set — the distinct logo keys among the cycled
    // flights (<= maxFlights, plus the _CARGO/_HELI/_PRIVATE pseudo-keys). Cards
    // cycle round-robin, which is the LRU worst case: with capacity below the
    // working set the cache evicts precisely the tile needed next, so the hit rate
    // is ZERO, not merely reduced, and the pool costs RAM while buying nothing.
    // A hardcoded 4 did exactly that once maxFlights went past ~2 (see test_lru).
    // applySettings() sizes it from maxFlights; the {4} here is only the pre-init
    // default, since Settings aren't loaded yet when this global is constructed.
    LruCache<String, LogoTile> _logoCache{4};

    // Upper bound on the tile pool. Tiles are ~2KB, which is BELOW the 4096-byte
    // CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL threshold — so they land in INTERNAL RAM
    // on the S3 too, and 8MB of PSRAM does not rescue them. The cap keeps a large
    // maxFlights from eating the contiguous internal RAM the TLS handshake needs
    // (two ~16KB blocks). The S3 has room (~143KB largest block, measured); the
    // plain ESP32 has ~56KB after the 6-bit color-depth fix, and a big pool there
    // risks reintroducing the `? -> ?` TLS allocation failure.
#if defined(CONFIG_IDF_TARGET_ESP32S3)
    static constexpr size_t kMaxLogoTiles = 16; // ~32KB
#else
    static constexpr size_t kMaxLogoTiles = 8; // ~16KB
#endif

    // Whether the last drawLogoOrBadge() painted a real tile (vs. the code badge).
    // displayMiniCard() uses it to drop the redundant "Airlines/Airways" suffix.
    bool _lastDrewLogo = false;

    void present(); // blit the canvas to the panel

    void drawTextLine(int16_t x, int16_t y, const String &text, uint16_t color);
    String truncateToColumns(const String &text, int maxColumns);

    // The tracked-flight marker: a 1px white border round the whole panel with
    // TRACKED in the top-right. The length is stated rather than measured
    // because it is needed for LAYOUT, in displayMiniCard, before anything is
    // drawn -- sizeof-1 keeps the two from drifting if the word ever changes.
    static constexpr const char *TRACKED_LABEL = "TRACKED";
    static constexpr size_t TRACKED_LABEL_LEN = sizeof("TRACKED") - 1;
    // Which layout displayFlightCard will pick, as a predicate: the tracked
    // label needs the answer BEFORE the card is drawn, and a second copy of
    // the test is how the label ends up on a card that never reserved room.
    bool usesMiniCard() const { return _matrixHeight >= 48 && _matrixWidth >= 96; }
    int16_t trackedLabelX() const;
    void drawTrackedChrome();
    void buildFlightLines(const FlightInfo &f, std::vector<String> &outLines, bool includeAirline);
    void displayFlightCard(const FlightInfo &f);     // picks a layout by panel shape
    void displayMiniCard(const FlightInfo &f);       // big panels (128x64): logo + info + metric rows
    void displaySideBySideCard(const FlightInfo &f); // wide panels: logo left, text right
    void displayStackedCard(const FlightInfo &f);    // square/tall panels: logo top, text below
    void displayTextOnlyCard(const FlightInfo &f);   // very short panels: bordered text
    void displayLoadingScreen();
    // ONE decode of layout.noFlightsMode, used by both the dispatcher and the
    // recompose key.
    //
    // They used to decode it independently, each re-deriving which sub-screen
    // clockfact is currently showing from its own millis() read, and each
    // resolving "clock wanted but time not synced" its own way -- so in plain
    // clock mode before NTP the key advanced every rotate interval while the
    // screen stayed on static dots, recomposing for a picture that never
    // changed. Deciding once removes the possibility of the two disagreeing.
    struct NoFlightsFrame
    {
        enum class Screen
        {
            Dots,
            Clock,
            Fact
        };
        Screen screen = Screen::Dots;
        long key = -1;      // -1 = static, never needs recomposing
        size_t factIdx = 0; // valid only when screen == Fact
    };
    NoFlightsFrame noFlightsFrame() const;

    void displayNoFlights();                                 // dispatches by noFlightsFrame()
    void drawClockScreen();                                  // large HH:MM + date line
    void drawFunFactScreen(size_t factIdx);                  // word-wrapped fun fact
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
