/*
Purpose: Render flight info on a HUB75 RGB LED matrix.
Responsibilities:
- Initialize the panel from runtime Settings (geometry/brightness) and the
  compile-time HUB75 pin map (HardwareConfiguration).
- Compose each frame into an in-RAM GFXcanvas16, then blit it to the panel.
- Render a Mini-style flight card (airline logo tile + flight #, route, aircraft,
  and the configured metrics), cycling through multiple flights.
Inputs: FlightInfo list; g_settings (colors/brightness/layout/cycle/geometry).
*/
#include "adapters/Hub75Display.h"
#include "utils/MetricRow.h"

#include <Adafruit_GFX.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <LittleFS.h>
#include <time.h>
#include "esp_heap_caps.h"
#include "config/HardwareConfiguration.h"
#include "config/FunFacts.h"
#include "utils/ServerJson.h" // renderable()
#include "core/Settings.h"
#include "utils/ClockFormat.h"

// How long each fun fact stays up / how long the clock<->fact alternation holds,
// in milliseconds. Reused as the clock recompose granularity is per-minute.
static const unsigned long kNoFlightsRotateMs = 7000UL;

static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b)
{
    return ((uint16_t)(r & 0xF8) << 8) | ((uint16_t)(g & 0xFC) << 3) | (b >> 3);
}

// Exposes the DMA restart the base class does not.
//
// dma_bus is protected, and the library says outright that its protected members
// "might be useful for child classes" -- so this is the sanctioned seam rather
// than a reach into private state. Nothing else is added or overridden.
class RestartablePanel : public MatrixPanel_I2S_DMA
{
public:
    explicit RestartablePanel(const HUB75_I2S_CFG &cfg) : MatrixPanel_I2S_DMA(cfg) {}
    void resumeDMAoutput() { dma_bus.dma_transfer_start(); }
};

Hub75Display::Hub75Display() {}

Hub75Display::~Hub75Display()
{
    if (_canvas)
    {
        delete _canvas;
        _canvas = nullptr;
    }
    if (_panel)
    {
        delete _panel;
        _panel = nullptr;
    }
}

bool Hub75Display::initialize()
{
    _matrixWidth = (uint16_t)(g_settings.panelResX * g_settings.panelChain);
    _matrixHeight = g_settings.panelResY;

    HUB75_I2S_CFG::i2s_pins pins = {
        HardwareConfiguration::HUB75_R1, HardwareConfiguration::HUB75_G1, HardwareConfiguration::HUB75_B1,
        HardwareConfiguration::HUB75_R2, HardwareConfiguration::HUB75_G2, HardwareConfiguration::HUB75_B2,
        HardwareConfiguration::HUB75_A, HardwareConfiguration::HUB75_B, HardwareConfiguration::HUB75_C,
        HardwareConfiguration::HUB75_D, HardwareConfiguration::HUB75_E,
        HardwareConfiguration::HUB75_LAT, HardwareConfiguration::HUB75_OE, HardwareConfiguration::HUB75_CLK};

    HUB75_I2S_CFG mxconfig(
        (uint16_t)g_settings.panelResX,
        (uint16_t)g_settings.panelResY,
        (uint8_t)g_settings.panelChain,
        pins);

    // Signal-integrity tuning (fixes flicker / off-by-one on many panels).
    mxconfig.clkphase = g_settings.panelClkPhase;
    mxconfig.latch_blanking = g_settings.panelLatchBlanking;
    switch (g_settings.panelI2sSpeedMhz)
    {
    case 20:
        mxconfig.i2sspeed = HUB75_I2S_CFG::HZ_20M;
        break;
    case 15:
    case 16:
        mxconfig.i2sspeed = HUB75_I2S_CFG::HZ_16M;
        break;
    default:
        mxconfig.i2sspeed = HUB75_I2S_CFG::HZ_8M;
        break;
    }
    String drv = g_settings.panelDriverChip;
    drv.toLowerCase();
    if (drv == "fm6126a")
        mxconfig.driver = HUB75_I2S_CFG::FM6126A;
    else if (drv == "fm6124")
        mxconfig.driver = HUB75_I2S_CFG::FM6124;
    else if (drv == "icn2038s")
        mxconfig.driver = HUB75_I2S_CFG::ICN2038S;
    else if (drv == "mbi5124")
        mxconfig.driver = HUB75_I2S_CFG::MBI5124;
    else
        mxconfig.driver = HUB75_I2S_CFG::SHIFTREG;

    // [heapdiag] Measure how much the HUB75 DMA framebuffer reserves — prime
    // suspect for the contiguous-internal-RAM shortage that breaks TLS handshakes.
    size_t intBeforePanel = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    size_t dmaBeforePanel = heap_caps_get_free_size(MALLOC_CAP_DMA);
    // RestartablePanel, not MatrixPanel_I2S_DMA: stopOutput()/startOutput()
    // below need dma_bus, which the base class keeps protected -- deliberately
    // available to child classes, per its own comment. Every construction of
    // _panel must use this type; startOutput() downcasts on that promise.
    _panel = new RestartablePanel(mxconfig);
    _panel->begin();
    size_t intAfterPanel = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    size_t dmaAfterPanel = heap_caps_get_free_size(MALLOC_CAP_DMA);
    Serial.printf("[heapdiag] HUB75 panel: internal used ~%u (free %u->%u), DMA used ~%u (free %u->%u), largestInternal=%u\n",
                  (unsigned)(intBeforePanel - intAfterPanel), (unsigned)intBeforePanel, (unsigned)intAfterPanel,
                  (unsigned)(dmaBeforePanel - dmaAfterPanel), (unsigned)dmaBeforePanel, (unsigned)dmaAfterPanel,
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    _panel->setBrightness8(g_settings.brightness);
    _panel->clearScreen();

    size_t intBeforeCanvas = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    _canvas = new GFXcanvas16(_matrixWidth, _matrixHeight);
    Serial.printf("[heapdiag] GFXcanvas16(%ux%u): internal used ~%u, largestInternal=%u\n",
                  _matrixWidth, _matrixHeight,
                  (unsigned)(intBeforeCanvas - heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    _canvas->setTextWrap(false);
    _canvas->setTextSize(1);

    clear();
    _currentFlightIndex = 0;
    _lastCycleMs = millis();
    applySettings();
    return true;
}

void Hub75Display::applySettings()
{
    // Working set = distinct logo keys among the cycled cards: at most maxFlights
    // operator tiles, plus the three pseudo-keys (_CARGO/_HELI/_PRIVATE) that can
    // coexist with them when an operator tile is missing. Undersizing this is not a
    // partial win — round-robin cycling makes an undersized LRU miss every time.
    size_t want = (size_t)g_settings.maxFlights + 3;
    if (want < 4)
        want = 4; // keep the old floor for tiny maxFlights
    if (want > kMaxLogoTiles)
        want = kMaxLogoTiles; // bounded: tiles are internal RAM on both targets
    if (want != _logoCache.capacity())
    {
        // Shrinking frees the evicted tiles immediately (setCapacity trims).
        _logoCache.setCapacity(want);
        Serial.printf("[logo] tile cache capacity=%u (maxFlights=%u)\n",
                      (unsigned)want, (unsigned)g_settings.maxFlights);
    }
}

void Hub75Display::present()
{
    if (!_panel || !_canvas)
        return;
    // Overlay here rather than in each compose path: present() is the single blit
    // point every screen funnels through (flight cards, all four no-flights modes,
    // splash, messages), so the toast works over all of them for free.
    drawToastIfActive();
    _panel->drawRGBBitmap(0, 0, _canvas->getBuffer(), _matrixWidth, _matrixHeight);
}

void Hub75Display::showToast(const String &text, unsigned long durationMs)
{
    _toastText = text;
    _toastUntilMs = millis() + durationMs;
    // Force a recompose so it appears on the next ~200ms tick instead of waiting for
    // the cycle to advance or a fetch to land.
    markFlightsUpdated();
}

void Hub75Display::drawToastIfActive()
{
    if (_toastUntilMs == 0 || millis() >= _toastUntilMs || !_canvas)
        return;
    // Bottom strip, blacked out and rimmed: readable over any card without needing to
    // know that card's layout.
    const int16_t h = 9;
    const int16_t y = (int16_t)_matrixHeight - h;
    _canvas->fillRect(0, y, _matrixWidth, h, 0);
    _canvas->drawFastHLine(0, y, _matrixWidth, 0x39E7); // dim rule to lift it off the card
    drawTextLine(2, y + 2, _toastText, 0xFFFF);
}

void Hub75Display::setBrightness(uint8_t brightness)
{
    if (_panel)
        _panel->setBrightness8(brightness);
}

uint16_t Hub75Display::textColor()
{
    return rgb565(g_settings.textColorR, g_settings.textColorG, g_settings.textColorB);
}

void Hub75Display::clear()
{
    if (!_canvas)
        return;
    _canvas->fillScreen(0);
    if (_panel)
        _panel->clearScreen();
    present();
}

void Hub75Display::drawTextLine(int16_t x, int16_t y, const String &text, uint16_t color)
{
    _canvas->setCursor(x, y);
    _canvas->setTextColor(color);
    for (size_t i = 0; i < (size_t)text.length(); ++i)
        _canvas->write(text[i]);
}

String Hub75Display::truncateToColumns(const String &text, int maxColumns)
{
    if ((int)text.length() <= maxColumns)
        return text;
    if (maxColumns <= 3)
        return text.substring(0, maxColumns);
    return text.substring(0, maxColumns - 3) + String("...");
}

static String formatAltitude(double altFt)
{
    if (!renderable(altFt))
        return String("");
    long ft = (long)(altFt + 0.5);
    if (ft >= 18000)
        return String("FL") + String((long)((ft + 50) / 100));
    return String(ft) + "ft";
}

static String formatHeading(double deg)
{
    if (!renderable(deg))
        return String("");
    long d = ((long)(deg + 0.5)) % 360;
    if (d < 0)
        d += 360;
    char buf[8];
    snprintf(buf, sizeof(buf), "HDG%03ld", d);
    return String(buf);
}

// AeroAPI's Flights-mode feed reports a DIRECTION rather than a rate: a
// documented +/-1.0 sentinel meaning "climbing" / "descending", not one foot per
// minute. Both vertical-rate formatters have to know that, so the rule lives in
// one place rather than in whichever of them happens to remember it.
static bool isDirectionOnlyRate(double fpm) { return fabs(fpm) <= 2.0; }

static String directionOnlyRate(double fpm)
{
    if (fpm > 0)
        return String("CLB");
    if (fpm < 0)
        return String("DES");
    return String("LVL");
}

static String formatVerticalRate(double fpm)
{
    if (!renderable(fpm))
        return String("");
    if (isDirectionOnlyRate(fpm))
        return directionOnlyRate(fpm);
    long v = (long)(fpm + (fpm >= 0 ? 0.5 : -0.5));
    return String(v > 0 ? "+" : "") + String(v) + "fpm";
}

void Hub75Display::buildFlightLines(const FlightInfo &f, std::vector<String> &outLines, bool includeAirline)
{
    const DisplayLayout &L = g_settings.layout;

    if (L.showAirlineFlight)
    {
        String ident = f.ident.length() ? f.ident : f.ident_icao;
        String line;
        if (includeAirline)
        {
            line = f.airline_display_name_full.length() ? f.airline_display_name_full
                   : (f.operator_iata.length() ? f.operator_iata
                      : (f.operator_icao.length() ? f.operator_icao : f.operator_code));
        }
        if (ident.length())
            line += (line.length() ? " " : "") + ident;
        if (line.length())
            outLines.push_back(line);
    }

    if (L.showRoute)
    {
        String origin = f.origin.displayCode();
        String dest = f.destination.displayCode();
        if (origin.length() || dest.length())
            outLines.push_back(origin + ">" + dest);
    }

    // Rendered VERBATIM. eta_text is the server's pre-rounded string -- 5 min
    // under an hour, 10 over, "LANDING" inside 30nm -- and that rounding is
    // the honesty policy: the model cannot know about vectoring, holds or
    // taxi-in. Re-deriving a string from eta_minutes here would give a second
    // implementation that could disagree with the server's for the same
    // flight. Empty for every OpenSky/adsb.lol flight and any server flight
    // with no destination, so this adds nothing for them.
    if (L.showEta && f.eta_text.length())
        outLines.push_back(f.eta_text);

    if (L.showAircraft)
    {
        String type = f.aircraft_code;
        if (type.length())
            outLines.push_back(type);
    }

    if (L.showAltitude)
    {
        String a = formatAltitude(f.altitude_ft);
        if (a.length())
            outLines.push_back(a);
    }

    if (L.showSpeed && renderable(f.groundspeed_kt))
        outLines.push_back(String((long)(f.groundspeed_kt + 0.5)) + "kt");

    if (L.showHeading)
    {
        String h = formatHeading(f.heading_deg);
        if (h.length())
            outLines.push_back(h);
    }

    if (L.showVerticalRate)
    {
        String v = formatVerticalRate(f.vertical_rate_fpm);
        if (v.length())
            outLines.push_back(v);
    }
}

// Cache-or-load the decoded tile for `key`. A failed load is cached as an empty
// LogoTile (w==0) — that negative entry is what keeps a flight with no operator
// tile from re-opening LittleFS on every single recompose.
const Hub75Display::LogoTile *Hub75Display::tileFor(const String &key)
{
    if (key.length() == 0)
        return nullptr;
    if (LogoTile *hit = _logoCache.find(key))
        return hit; // hit — including a cached miss (w==0)

    LogoTile tile; // stays w==0 on any failure below -> negative cache entry

    String path = String("/logos/") + key + ".rgb565";
    File f = LittleFS.open(path, "r");
    if (f)
    {
        uint8_t hdr[4];
        if (f.read(hdr, 4) == 4)
        {
            int w = hdr[0] | (hdr[1] << 8);
            int h = hdr[2] | (hdr[3] << 8);
            if (w > 0 && h > 0 && w <= 64 && h <= 64)
            {
                size_t count = (size_t)w * (size_t)h;
                std::vector<uint16_t> px(count);
                size_t want = count * sizeof(uint16_t);
                // stored little-endian == ESP32 native
                if (f.read((uint8_t *)px.data(), want) == want)
                {
                    tile.w = (uint16_t)w;
                    tile.h = (uint16_t)h;
                    tile.px = std::move(px);
                }
            }
        }
        f.close();
    }

    // Move the decoded tile straight in and use the slot put() hands back. The
    // old shape inserted an empty LogoTile first and then found it -- which
    // stored the w==0 "known missing" sentinel for the duration, and assumed
    // the find could not fail. It can: with capacity 0 the entry is evicted on
    // the way in, and _logoCache is sized from a runtime setting.
    return _logoCache.put(key, std::move(tile));
}

// The key the accent colour is hashed from.
//
// Two call sites used to derive this differently for the same flight: the badge
// fill hashed operator_icao else the uppercased FIRST TWO CHARS of
// iata/icao/operator_code, while the side-by-side separator hashed operator_icao
// else the FULL operator_code. accentColorFor is FNV-1a, so for any flight
// WITHOUT an operator_icao -- GA and private traffic, which is most of what has
// no ICAO operator -- the badge and the separator came out completely unrelated
// hues on the same card.
//
// Unified on the full string rather than the two-char prefix: more input means
// fewer carriers colliding onto one colour. operator_iata is the last resort
// rather than the second, so the key is never the empty string (which would
// hash every operator-less flight to one shared colour).
static String operatorAccentKey(const FlightInfo &f)
{
    if (f.operator_icao.length())
        return f.operator_icao;
    if (f.operator_code.length())
        return f.operator_code;
    return f.operator_iata;
}

uint16_t Hub75Display::accentColorFor(const String &code)
{
    uint32_t hash = 2166136261UL; // FNV-1a
    for (size_t i = 0; i < (size_t)code.length(); ++i)
    {
        hash ^= (uint8_t)code[i];
        hash *= 16777619UL;
    }
    uint8_t r = 70 + (hash & 0x7F);
    uint8_t g = 70 + ((hash >> 8) & 0x7F);
    uint8_t b = 70 + ((hash >> 16) & 0x7F);
    return rgb565(r, g, b);
}

void Hub75Display::drawLogoOrBadge(const FlightInfo &f, int16_t x, int16_t y, int16_t w, int16_t h)
{
    // Logo selection priority (first that loads wins):
    //   1. helicopter -> generic rotorcraft icon (must NOT fall to _PRIVATE)
    //   2. private     -> generic private-jet icon
    //   3. operator's real/badge tile (if it has one)
    //   4. cargo       -> generic cargo icon (only when no specific operator tile)
    //   5. text/accent fallback (below)
    const LogoTile *tile = nullptr;
    if (f.is_helicopter)
        tile = tileFor("_HELI");
    else if (f.is_private)
        tile = tileFor("_PRIVATE");
    if ((!tile || tile->w == 0) && f.operator_icao.length())
        tile = tileFor(f.operator_icao);
    if ((!tile || tile->w == 0) && f.is_cargo)
        tile = tileFor("_CARGO");

    const bool haveLogo = (tile && tile->w != 0);
    _lastDrewLogo = haveLogo;
    if (haveLogo)
    {
        const uint16_t *pixels = tile->px.data();
        const int lw = tile->w, lh = tile->h;
        // Integer-scale the native tile to fill the box (1x for a 32px tile in a
        // 32px box, 2x for a 16px tile, etc.).
        int scale = min(w / lw, h / lh);
        if (scale < 1)
            scale = 1;
        const int16_t sw = lw * scale, sh = lh * scale;
        const int16_t lx = x + (w - sw) / 2;
        const int16_t ly = y + (h - sh) / 2;
        if (scale == 1)
        {
            // Cast away const deliberately: Adafruit_GFX overloads drawRGBBitmap on
            // uint16_t* (RAM) vs const uint16_t[] (PROGMEM). We want the RAM one,
            // same as before. drawRGBBitmap does not write through the pointer.
            _canvas->drawRGBBitmap(lx, ly, const_cast<uint16_t *>(pixels), lw, lh);
        }
        else
        {
            for (int j = 0; j < lh; ++j)
                for (int i = 0; i < lw; ++i)
                    _canvas->fillRect(lx + i * scale, ly + j * scale, scale, scale,
                                      pixels[j * lw + i]);
        }
        return;
    }

    // The two-character badge TEXT keeps its own iata-first chain -- that is what
    // reads best in a 2-glyph box -- but the COLOUR is keyed independently, and
    // on the full string. They were entangled before, which is how the badge and
    // the separator ended up hashing different things.
    String code = f.operator_iata.length() ? f.operator_iata
                  : (f.operator_icao.length() ? f.operator_icao : f.operator_code);
    code = code.substring(0, 2);
    code.toUpperCase();
    const String key = operatorAccentKey(f);

    const uint8_t ts = (h >= 24) ? 2 : 1; // larger code text in a tall box
    _canvas->fillRect(x, y, w, h, accentColorFor(key));
    if (code.length())
    {
        const int charWidth = 6 * ts, charHeight = 8 * ts;
        int16_t cx = x + (w - (int)code.length() * charWidth) / 2;
        int16_t cy = y + (h - charHeight) / 2;
        _canvas->setTextSize(ts);
        drawTextLine(cx, cy, code, rgb565(255, 255, 255));
        _canvas->setTextSize(1);
    }
}

// Trim/truncate `lines` to what fits in availHeight, returns the total text
// height (so callers can vertically center). 6x8 font + 1px line spacing.
int16_t Hub75Display::fitLines(std::vector<String> &lines, int maxCols, int availHeight)
{
    if (maxCols < 1)
        maxCols = 1;
    const int charHeight = 8, lineSpacing = 1, perLine = charHeight + lineSpacing;
    int maxLines = (availHeight + lineSpacing) / perLine;
    if (maxLines < 1)
        maxLines = 1;
    if ((int)lines.size() > maxLines)
        lines.resize(maxLines);
    for (auto &ln : lines)
        ln = truncateToColumns(ln, maxCols);
    const int n = (int)lines.size();
    return (int16_t)(n * charHeight + (n - 1) * lineSpacing);
}

// Where the TRACKED label starts, right-aligned inside the border, or -1 when
// this panel is too narrow to carry it. displayMiniCard calls this BEFORE it
// lays out its top line so the airline name can stop short of the label rather
// than running underneath it; drawTrackedChrome then draws at the same x.
//
// The label is deliberately the full word rather than an abbreviation: it is
// the only thing on the panel that says WHY this card looks different, and a
// wall display is read from across a room, where "TRK" is a guess.
int16_t Hub75Display::trackedLabelX() const
{
    // ONLY the Mini layout. It is the one that reserves columns for this (see
    // displayMiniCard), and the others actively collide: the Stacked card
    // centres a 32px logo at the very top, so a label right-aligned there
    // would be drawn straight across it. Gated on the same predicate the
    // dispatcher selects the layout with, so the two cannot drift into
    // disagreeing about which card is on screen. Those panels still get the
    // border, which is what says "tracked"; only the word is dropped.
    if (!usesMiniCard())
        return -1;
    const int16_t w = (int16_t)(TRACKED_LABEL_LEN * 6); // 6px advance per glyph
    const int16_t x = (int16_t)(_matrixWidth - 1 - w);
    return x >= 0 ? x : (int16_t)-1;
}

// A 1px white border around the whole panel, plus TRACKED in the top-right.
//
// Drawn LAST, over the finished card, which is the opposite of the amber bar
// this replaces: a bar only had to survive in the margin, whereas a border has
// to close. A border with a gap in it does not read as a border at all, it
// reads as a rendering fault -- so where a glyph reaches the outermost column
// the border wins, costing that glyph one pixel of its edge. Nothing in the
// Mini layout gets that close (its logo starts at x=2, its metric rows at x=1,
// and its text stops well inside the last column), so on the 128x64 wall this
// costs nothing at all.
//
// This is the whole marker now: a dead-reckoned position is no longer drawn
// differently from an observed one. That was a deliberate call -- see
// HANDOFF.md. `pos_src` is untouched on the wire and still visible in
// /api/flights and on the server's watched-flights page.
void Hub75Display::drawTrackedChrome()
{
    const uint16_t white = rgb565(255, 255, 255);
    _canvas->drawRect(0, 0, _matrixWidth, _matrixHeight, white);

    // y=1 clears the border's own top row. The label and the airline name share
    // rows 4-7 but never a column: at 128px the name is cut to 7 chars, ending
    // at x=80, and the label starts at x=85.
    const int16_t x = trackedLabelX();
    if (x >= 0)
        drawTextLine(x, 1, String(TRACKED_LABEL), white);
}

void Hub75Display::stopOutput()
{
    if (!_panel)
        return;
    _panel->stopDMAoutput();
}

void Hub75Display::startOutput()
{
    if (!_panel)
        return;
    // Safe because begin() only ever constructs a RestartablePanel.
    //
    // The base class documents stopDMAoutput() as permanent ("black until next
    // ESP reboot") and offers no resume, but on the S3 the two halves are
    // symmetric: dma_transfer_stop() is gdma_stop(), and dma_transfer_start()
    // is gdma_start() over the SAME descriptor chain, which stopping never
    // freed. What stopping does discard is the framebuffer contents
    // (resetbuffers()), so a caller must redraw after this -- it resumes an
    // empty screen, not the one that was there before.
    static_cast<RestartablePanel *>(_panel)->resumeDMAoutput();
}

void Hub75Display::displayFlightCard(const FlightInfo &f)
{
    if (usesMiniCard())
        displayMiniCard(f); // big panel (e.g. 128x64): logo + 3 info lines + 2 metric rows
    else if (_matrixHeight < 16)
        displayTextOnlyCard(f); // too short for a logo
    else if (_matrixWidth >= _matrixHeight * 2)
        displaySideBySideCard(f); // wide & short (128x32, 160x32, 64x32)
    else
        displayStackedCard(f); // square / tall (64x64)

    // After the layout, never inside one: every card shape gets the same
    // marker, including displayTextOnlyCard, which the old bar missed entirely
    // because it lived in drawLogoOrBadge and that layout never calls it.
    if (f.pinned)
        drawTrackedChrome();
}

// "ORD-LAX" style route, preferring IATA codes.
static String iataRoute(const FlightInfo &f)
{
    String o = f.origin.displayCode();
    String d = f.destination.displayCode();
    if (!o.length() && !d.length())
        return String("");
    return o + "-" + d;
}

// Metric formatters. When `unit` is false the unit suffix is dropped (used to
// reclaim width instead of truncating with an ellipsis).
static String miniAlt(double ft, bool unit)
{
    if (!renderable(ft))
        return String("");
    if (ft >= 1000)
    {
        char b[12];
        snprintf(b, sizeof(b), unit ? "%.1fkft" : "%.1fk", ft / 1000.0);
        return String(b);
    }
    return String((long)(ft + 0.5)) + (unit ? "ft" : "");
}

static String miniSpdMph(double kt, bool unit)
{
    if (!renderable(kt))
        return String("");
    return String((long)(kt * 1.15078 + 0.5)) + (unit ? "mph" : "");
}

static String miniTrk(double deg, bool unit)
{
    if (!renderable(deg))
        return String("");
    long d = ((long)(deg + 0.5)) % 360;
    if (d < 0)
        d += 360;
    return String(d) + (unit ? "deg" : "");
}

static String miniVr(double fpm, bool unit)
{
    if (!renderable(fpm))
        return String("");
    // Without this the sentinel divided by 60 and rounded to zero, so the mini
    // layout printed "0ft/s" -- LEVEL -- for an aircraft AeroAPI had reported as
    // climbing or descending, while formatVerticalRate on every other layout
    // showed CLB/DES for the same flight. Same defect as AirportInfo's display
    // code: one rule, two encodings, one of them wrong.
    if (isDirectionOnlyRate(fpm))
        return directionOnlyRate(fpm);
    long fps = (long)(fpm / 60.0 + (fpm >= 0 ? 0.5 : -0.5));
    return String(fps) + (unit ? "ft/s" : "");
}

// Small per-airline display-name fixups (spacing / branding). Extend as needed —
// keyed by operator ICAO; returns `fallback` unchanged when there's no override.
static String airlineNameOverride(const String &icao, const String &fallback)
{
    if (icao.equalsIgnoreCase("SWR"))
        return String("Swiss Air"); // CDN returns "Swissair"
    return fallback;
}

// Drop the redundant airline-suffix words (the logo conveys it):
//   "United Airlines"   -> "United"
//   "British Airways"   -> "British"
//   "Delta Air Lines"   -> "Delta"      (two-word "Air Line(s)")
// Keeps brand uses of "Air" like "Air France" / "Air China". Returns the original
// if stripping would leave nothing.
static String stripAirlineWords(const String &name)
{
    std::vector<String> toks;
    int start = 0;
    const int n = (int)name.length();
    while (start < n)
    {
        int sp = name.indexOf(' ', start);
        String tok = (sp < 0) ? name.substring(start) : name.substring(start, sp);
        if (tok.length())
            toks.push_back(tok);
        if (sp < 0)
            break;
        start = sp + 1;
    }

    auto lower = [](const String &s)
    { String t = s; t.toLowerCase(); return t; };

    String out;
    for (size_t i = 0; i < toks.size(); ++i)
    {
        String l = lower(toks[i]);
        // Two-word "Air Line"/"Air Lines" — drop both tokens.
        if (l == "air" && i + 1 < toks.size())
        {
            String l2 = lower(toks[i + 1]);
            if (l2 == "lines" || l2 == "line")
            {
                ++i;
                continue;
            }
        }
        // Single-word suffixes.
        if (l == "airline" || l == "airlines" || l == "airway" || l == "airways")
            continue;
        if (out.length())
            out += " ";
        out += toks[i];
    }
    out.trim();
    return out.length() ? out : name;
}

void Hub75Display::displayMiniCard(const FlightInfo &f)
{
    const uint16_t color = textColor();

    // Logo: 32x32 box, top-left (nudged down a few px for vertical balance).
    const int16_t box = 32;
    const int16_t topY = 4;
    drawLogoOrBadge(f, 2, topY, box, box);

    // Three info lines to the right of the logo (airline / route / aircraft).
    const int16_t tx = 2 + box + 4; // ~38
    const int topCols = (_matrixWidth - tx - 1) / 6;

    // The TRACKED label shares the first line's row, so on a tracked card the
    // airline name gets only the columns left of it (14 -> 7 at 128px wide).
    // Only the AIRLINE line is shortened: route and aircraft sit on rows the
    // label does not occupy and keep the full width. A negative result means
    // the label leaves no usable columns at all, in which case the name is
    // dropped rather than drawn as a stub -- the label still says what the card
    // is, which is the more useful of the two in that space.
    const int16_t labelX = f.pinned ? trackedLabelX() : (int16_t)-1;
    const int topColsAirline = labelX < 0 ? topCols : (labelX - 2 - tx) / 6;

    String airline = f.airline_display_name_full.length() ? f.airline_display_name_full
                     : (f.operator_iata.length() ? f.operator_iata
                        : (f.operator_icao.length() ? f.operator_icao : f.operator_code));
    String route = iataRoute(f);
    String type = f.aircraft_code;
    airline = airlineNameOverride(f.operator_icao, airline);
    if (!airline.length())
        airline = f.ident.length() ? f.ident : String("?");
    // When a real logo tile is shown, the "Airlines/Airways" suffix is redundant.
    // drawLogoOrBadge() above set _lastDrewLogo for exactly this flight's tile.
    if (_lastDrewLogo)
        airline = stripAirlineWords(airline);

    if (topColsAirline > 0)
        drawTextLine(tx, topY, truncateToColumns(airline, topColsAirline), color);
    if (route.length())
        drawTextLine(tx, topY + 11, truncateToColumns(route, topCols), color);
    if (type.length())
        drawTextLine(tx, topY + 22, truncateToColumns(type, topCols), color);

    // Two full-width metric rows at the bottom. If a row doesn't fit, we drop the
    // unit suffixes (mph/ft/deg/...) to reclaim width rather than truncating with
    // an ellipsis — the numbers stay readable.
    const int botCols = (_matrixWidth - 2) / 6;
    const DisplayLayout &L = g_settings.layout;

    auto buildRow1 = [&](bool unit)
    {
        String r;
        if (L.showAltitude)
        {
            String a = miniAlt(f.altitude_ft, unit);
            if (a.length())
                r = "Alt:" + a;
        }
        if (L.showSpeed)
        {
            String s = miniSpdMph(f.groundspeed_kt, unit);
            if (s.length())
                r += (r.length() ? " " : "") + String("Spd:") + s;
        }
        return r;
    };
    // Row 2 is filled from an ORDERED candidate list against the column
    // budget, not from a chain of mutually-exclusive branches.
    //
    // It used to be a chain: Trk, then exactly ONE of ETA / flight number / Vr.
    // The width reasoning behind that was sound -- "Trk:230deg"(10) plus
    // "ETA:LANDING"(11) is 22 against botCols' 21 at 128px, so all three really
    // cannot share the row -- but the cost was that a card showing "lands in
    // 7h10" could never also say WHICH flight lands then, and that is the pair
    // a viewer most wants together. The old comment here anticipated this and
    // named the fix; joinWithinColumns() is it.
    //
    // Order below IS priority. ETA and the flight number lead because they
    // answer "what is this and when does it get there"; heading and vertical
    // rate are ambient detail that can be dropped when the row is tight. At
    // 128px the leading pair costs at most "ETA:LANDING"(11) + " " +
    // "SWA1234"(7) = 19 of 21, so Trk correctly gives way -- while a wider
    // panel has room for it and will show it.
    //
    // A candidate that does not fit is skipped rather than truncated, and
    // skipping it does not block a shorter later one, so Trk giving way to
    // "Vr:0" is expected behaviour.
    auto buildRow2 = [&](bool unit)
    {
        std::vector<String> cands;
        const bool haveEta = L.showEta && f.eta_text.length();
        if (haveEta)
            cands.push_back("ETA:" + f.eta_text);
        if (L.flightNumberOverVr)
        {
            const String flt = f.ident.length() ? f.ident : f.ident_icao;
            if (flt.length())
                cands.push_back(flt);
        }
        // Heading is a FALLBACK for the ETA, not an addition to it -- offered
        // only when there is no ETA to show. Leaving this to the width budget
        // instead would be subtly wrong: a short ETA and a short callsign
        // ("ETA:~1h AA1", 11 of 21 columns) leave room for "Trk:230", so
        // heading would appear on some cards and not others for no reason a
        // viewer could see. "Where is it pointing" is the consolation for not
        // knowing "when does it arrive", and once the arrival IS known the
        // heading is the less interesting of the two.
        if (L.showHeading && !haveEta)
        {
            const String t = miniTrk(f.heading_deg, unit);
            if (t.length())
                cands.push_back("Trk:" + t);
        }
        if (L.showVerticalRate)
        {
            const String v = miniVr(f.vertical_rate_fpm, unit);
            if (v.length())
                cands.push_back("Vr:" + v);
        }
        return joinWithinColumns(cands, botCols);
    };

    String row1 = buildRow1(true);
    if ((int)row1.length() > botCols)
        row1 = buildRow1(false); // drop units instead of "..."
    String row2 = buildRow2(true);
    if ((int)row2.length() > botCols)
        row2 = buildRow2(false);

    // Last-resort clamp, not the normal path: every OTHER value composed above
    // is a formatted number with an inherently bounded width (a heading is
    // always <=3 digits, etc.), so the unit-drop fallback alone has always been
    // enough. eta_text is the first piece of this row that is an arbitrary
    // STRING from the wire with no length cap between the server and here --
    // fine for any real eta_text (worst realistic case computed above still
    // fits after the fallback), but a malformed value must not be able to push
    // text off the edge of the panel. truncateToColumns() is already a no-op
    // when the row fits (same unconditional-call style as the topCols lines
    // above), so this changes nothing in the normal case.
    row1 = truncateToColumns(row1, botCols);
    row2 = truncateToColumns(row2, botCols);

    int16_t by = (row1.length() && row2.length()) ? 40 : 44;
    if (row1.length())
    {
        drawTextLine(1, by, row1, color);
        by += 12;
    }
    if (row2.length())
        drawTextLine(1, by, row2, color);
}

void Hub75Display::displaySideBySideCard(const FlightInfo &f)
{
    const uint16_t color = textColor();

    const int16_t boxW = (_matrixWidth >= 48) ? 16 : (_matrixWidth / 3);
    const int16_t boxH = 16;
    const int16_t boxX = 1;
    const int16_t boxY = (_matrixHeight - boxH) / 2;
    drawLogoOrBadge(f, boxX, boxY, boxW, boxH);

    const int16_t sepX = boxX + boxW + 1;
    _canvas->drawLine(sepX, 1, sepX, _matrixHeight - 2, accentColorFor(operatorAccentKey(f)));

    const int16_t tx = sepX + 2;
    const int maxCols = (_matrixWidth - tx - 1) / 6;

    std::vector<String> lines;
    buildFlightLines(f, lines, /*includeAirline=*/false); // logo conveys the airline
    if (lines.empty())
        lines.push_back(f.ident.length() ? f.ident : String("?"));

    const int16_t totalH = fitLines(lines, maxCols, _matrixHeight);
    int16_t y = (_matrixHeight - totalH) / 2;
    for (const String &ln : lines)
    {
        drawTextLine(tx, y, ln, color);
        y += 9;
    }
}

void Hub75Display::displayStackedCard(const FlightInfo &f)
{
    const uint16_t color = textColor();

    // Bigger logo when there's vertical room (e.g. 64x64 -> 32px box).
    const int16_t boxW = (_matrixHeight >= 48) ? 32 : 16;
    const int16_t boxH = boxW;
    const int16_t boxX = (_matrixWidth - boxW) / 2;
    const int16_t boxY = 2;
    drawLogoOrBadge(f, boxX, boxY, boxW, boxH);

    const int16_t textTop = boxY + boxH + 2;
    const int maxCols = (_matrixWidth - 2) / 6;

    std::vector<String> lines;
    buildFlightLines(f, lines, /*includeAirline=*/false);
    if (lines.empty())
        lines.push_back(f.ident.length() ? f.ident : String("?"));

    const int availH = _matrixHeight - textTop;
    const int16_t totalH = fitLines(lines, maxCols, availH);
    int16_t y = textTop + (availH - totalH) / 2;
    for (const String &ln : lines)
    {
        // Center each line horizontally.
        const int16_t x = (_matrixWidth - (int)ln.length() * 6) / 2;
        drawTextLine(x < 0 ? 0 : x, y, ln, color);
        y += 9;
    }
}

void Hub75Display::displayTextOnlyCard(const FlightInfo &f)
{
    const uint16_t color = textColor();
    _canvas->drawRect(0, 0, _matrixWidth, _matrixHeight, color);

    const int charWidth = 6;
    const int charHeight = 8;
    const int padding = 2;
    const int innerWidth = _matrixWidth - 2 - (2 * padding);
    const int innerHeight = _matrixHeight - 2 - (2 * padding);
    const int maxCols = innerWidth / charWidth;
    const int lineSpacing = 1;

    std::vector<String> lines;
    buildFlightLines(f, lines, /*includeAirline=*/true);
    if (lines.empty())
        lines.push_back(f.ident.length() ? f.ident : String("?"));

    const int perLine = charHeight + lineSpacing;
    int maxLines = (innerHeight + lineSpacing) / perLine;
    if (maxLines < 1)
        maxLines = 1;
    if ((int)lines.size() > maxLines)
        lines.resize(maxLines);

    for (auto &ln : lines)
        ln = truncateToColumns(ln, maxCols);

    const int lineCount = (int)lines.size();
    const int totalTextHeight = lineCount * charHeight + (lineCount - 1) * lineSpacing;
    const int topOffset = 1 + padding + (innerHeight - totalTextHeight) / 2;
    const int16_t startX = 1 + padding;

    int16_t y = topOffset;
    for (const String &ln : lines)
    {
        drawTextLine(startX, y, ln, color);
        y += perLine;
    }
}

void Hub75Display::markFlightsUpdated()
{
    // Bump the data version so the next displayFlights() recomposes even if the
    // cycled index is unchanged (e.g. a fresh fetch at the same single flight).
    ++_dataVersion;
}

void Hub75Display::displayFlights(const std::vector<FlightInfo> &flights)
{
    if (!_canvas)
        return;

    // 1) Run the cycle-advance logic FIRST to decide which card we'd show now.
    //    SIZE_MAX is the "empty list / loading screen" sentinel.
    size_t indexToShow = SIZE_MAX;
    if (!flights.empty())
    {
        const unsigned long now = millis();
        const unsigned long intervalMs = g_settings.cycleSeconds * 1000UL;

        if (flights.size() > 1)
        {
            if (now - _lastCycleMs >= intervalMs)
            {
                _lastCycleMs = now;
                _currentFlightIndex = (_currentFlightIndex + 1) % flights.size();
            }
        }
        else
        {
            _currentFlightIndex = 0;
        }

        indexToShow = _currentFlightIndex % flights.size();
    }

    // 2) Dirty-check: skip the expensive recompose (string formatters + canvas
    //    redraw + blit) when neither the displayed card index nor the data
    //    version changed. A new fetch bumps _dataVersion via markFlightsUpdated();
    //    a cycle advance changes indexToShow; the empty<->non-empty transition is
    //    a change in indexToShow (SIZE_MAX vs a real index). The very first render
    //    composes because _lastComposedVersion(0) != _dataVersion(1).
    //    Exception: the empty-list (SIZE_MAX) animated modes (clock/funfact/
    //    clockfact) must redraw when their frame key changes (current minute for
    //    the clock, fact index for fun facts) even though indexToShow and
    //    _dataVersion are unchanged — otherwise the gate would freeze them.
    // A toast must ERASE itself, not merely appear. showToast() bumps _dataVersion so
    // it paints; without this, expiry changes neither the index nor the version, the
    // gate below returns early, and the toast stays burned on screen until the next
    // cycle advance. Same class of exception as the animated no-flights modes.
    if (_toastUntilMs != 0 && millis() >= _toastUntilMs)
    {
        _toastUntilMs = 0;
        ++_dataVersion; // one more recompose, now without the overlay
    }

    if (indexToShow == _lastComposedIndex && _dataVersion == _lastComposedVersion)
    {
        if (indexToShow != SIZE_MAX)
            return;
        const long key = noFlightsFrameKey();
        if (key < 0 || key == _lastNoFlightsKey)
            return; // static "dots" mode (key < 0) or same frame -> nothing to do
        _lastNoFlightsKey = key;
        // fall through to recompose the animated no-flights screen
    }

    _lastComposedIndex = indexToShow;
    _lastComposedVersion = _dataVersion;
    if (indexToShow == SIZE_MAX)
        _lastNoFlightsKey = noFlightsFrameKey();

    // 3) Compose the card (or no-flights screen for an empty list).
    _canvas->fillScreen(0);

    if (indexToShow != SIZE_MAX)
    {
        displayFlightCard(flights[indexToShow]);
    }
    else
    {
        displayNoFlights();
        return; // displayNoFlights presents already
    }

    present();
}

// Decide, once, what the no-flights screen should be showing and what value
// changes exactly when it needs redrawing.
//
// Everything that was duplicated lives here: which mode was configured, which
// half of clockfact's alternation is up, and whether a requested clock is
// actually usable (time(nullptr) < 100000 means NTP has not synced).
Hub75Display::NoFlightsFrame Hub75Display::noFlightsFrame() const
{
    const String &mode = g_settings.layout.noFlightsMode;
    const bool wantClock = (mode == "clock" || mode == "clockfact");
    const bool wantFact = (mode == "funfact" || mode == "clockfact");

    NoFlightsFrame f;
    if (!wantClock && !wantFact)
        return f; // "dots" or an unknown value -> static

    // Read millis() ONCE: both halves of clockfact derived their phase from
    // separate reads, which could straddle a rotate boundary.
    const unsigned long ticks = millis() / kNoFlightsRotateMs;
    const size_t factCount = kFunFactCount ? kFunFactCount : 1;
    const size_t factIdx = (size_t)(ticks % factCount);

    const bool clockPhase = (mode != "clockfact") || (ticks % 2 == 0);
    const bool synced = time(nullptr) >= 100000;

    if (wantClock && clockPhase && synced)
    {
        struct tm tmv;
        time_t now = time(nullptr);
        localtime_r(&now, &tmv); // TZ-aware (configTzTime); DST included
        f.screen = NoFlightsFrame::Screen::Clock;
        // Minute of day. The fact key below sits in a separate decade, so a
        // clockfact flip always moves the key even within the same minute.
        f.key = (long)tmv.tm_hour * 60L + tmv.tm_min;
        return f;
    }

    // Fact, either because it was asked for, or because clockfact is on its
    // fact phase, or because a clock was wanted and time is not synced yet.
    if (wantFact || (wantClock && !synced && mode == "clockfact"))
    {
        f.screen = NoFlightsFrame::Screen::Fact;
        f.factIdx = factIdx;
        f.key = 1000000L + (long)factIdx; // distinct decade from the clock key
        return f;
    }

    return f; // plain clock, not synced -> dots, and dots never animate
}

// Recompose key for the active no-flights mode. -1 means static.
long Hub75Display::noFlightsFrameKey()
{
    return noFlightsFrame().key;
}

// Dispatch the no-flights screen. Composes onto the canvas and presents.
void Hub75Display::displayNoFlights()
{
    const NoFlightsFrame f = noFlightsFrame();
    switch (f.screen)
    {
    case NoFlightsFrame::Screen::Clock:
        drawClockScreen();
        return;
    case NoFlightsFrame::Screen::Fact:
        drawFunFactScreen(f.factIdx);
        return;
    case NoFlightsFrame::Screen::Dots:
        break;
    }
    displayLoadingScreen();
}

// Large centered HH:MM with a "Mon Jun 17" date line below. Caller guarantees
// time is synced.
void Hub75Display::drawClockScreen()
{
    const uint16_t color = textColor();

    // One localtime_r replaces the hand-rolled offset + wrap + day-shift this used to
    // do (and which the date line below did differently, on a shifted time_t). libc
    // owns the zone via configTzTime, so DST is handled and the date can never
    // disagree with the time.
    time_t now = time(nullptr);
    struct tm tmv;
    localtime_r(&now, &tmv);

    char timeBuf[9]; // "12:00 AM" = 8 + NUL
    formatClock12(tmv.tm_hour, tmv.tm_min, timeBuf, sizeof(timeBuf));

    char dateBuf[16];
    strftime(dateBuf, sizeof(dateBuf), "%a %b %d", &tmv);

    // Pick a clock text size that fits the panel width (6x8 glyphs scale by size).
    uint8_t ts = 2;
    const int glyphs = (int)strlen(timeBuf);
    if (_matrixWidth >= glyphs * 6 * 3 && _matrixHeight >= 8 * 3 + 10)
        ts = 3;
    if (_matrixWidth < glyphs * 6 * 2)
        ts = 1;
    const int tW = (int)strlen(timeBuf) * 6 * ts; // "3:45 PM" / "12:00 AM" vary in width
    const int tH = 8 * ts;

    const bool haveDate = (_matrixHeight >= tH + 10);
    const int blockH = haveDate ? (tH + 2 + 8) : tH;
    int16_t ty = (_matrixHeight - blockH) / 2;
    if (ty < 0)
        ty = 0;
    int16_t tx = (_matrixWidth - tW) / 2;
    if (tx < 0)
        tx = 0;

    _canvas->setTextSize(ts);
    drawTextLine(tx, ty, String(timeBuf), color);
    _canvas->setTextSize(1);

    if (haveDate)
    {
        const int dW = (int)strlen(dateBuf) * 6;
        int16_t dx = (_matrixWidth - dW) / 2;
        if (dx < 0)
            dx = 0;
        drawTextLine(dx, ty + tH + 2, String(dateBuf), color);
    }
    present();
}

// Rotating, word-wrapped fun fact, vertically centered. Wraps on spaces into
// lines of at most maxCols columns; a single over-long word is truncated.
void Hub75Display::drawFunFactScreen(size_t factIdx)
{
    if (kFunFactCount == 0)
    {
        displayLoadingScreen();
        return;
    }
    const uint16_t color = textColor();
    // Which fact is decided by noFlightsFrame(), not re-derived here: this was a
    // third read of millis() that had to land on the same rotation as the
    // recompose key's.
    const size_t idx = factIdx % kFunFactCount;
    const String fact = String(kFunFacts[idx]);

    const int charWidth = 6, charHeight = 8, lineSpacing = 2;
    int maxCols = (_matrixWidth - 2) / charWidth;
    if (maxCols < 1)
        maxCols = 1;

    // Greedy word-wrap into lines of <= maxCols columns.
    std::vector<String> lines;
    String cur;
    int start = 0;
    const int n = (int)fact.length();
    while (start < n)
    {
        int sp = fact.indexOf(' ', start);
        String word = (sp < 0) ? fact.substring(start) : fact.substring(start, sp);
        if ((int)word.length() > maxCols) // single word too long: hard-truncate
            word = truncateToColumns(word, maxCols);
        if (cur.length() == 0)
            cur = word;
        else if ((int)(cur.length() + 1 + word.length()) <= maxCols)
            cur += " " + word;
        else
        {
            lines.push_back(cur);
            cur = word;
        }
        if (sp < 0)
            break;
        start = sp + 1;
    }
    if (cur.length())
        lines.push_back(cur);

    // Clamp to what fits vertically.
    const int perLine = charHeight + lineSpacing;
    int maxLines = (_matrixHeight + lineSpacing) / perLine;
    if (maxLines < 1)
        maxLines = 1;
    if ((int)lines.size() > maxLines)
        lines.resize(maxLines);

    const int count = (int)lines.size();
    const int totalH = count * charHeight + (count - 1) * lineSpacing;
    int16_t y = (_matrixHeight - totalH) / 2;
    if (y < 0)
        y = 0;
    for (const String &ln : lines)
    {
        int16_t x = (_matrixWidth - (int)ln.length() * charWidth) / 2;
        if (x < 0)
            x = 0;
        drawTextLine(x, y, ln, color);
        y += perLine;
    }
    present();
}

void Hub75Display::displayLoadingScreen()
{
    if (!_canvas)
        return;

    _canvas->fillScreen(0);

    const uint16_t color = textColor();
    _canvas->drawRect(0, 0, _matrixWidth, _matrixHeight, color);

    const int charWidth = 6;
    const int charHeight = 8;
    const String loadingText = "...";
    const int textWidth = loadingText.length() * charWidth;

    const int16_t x = (_matrixWidth - textWidth) / 2;
    const int16_t y = (_matrixHeight - charHeight) / 2 - 2;

    drawTextLine(x, y, loadingText, color);
    present();
}

// Branded boot splash: a small plane glyph above a centered "FlightWall"
// wordmark, with a "live flight tracker" tagline when there's vertical room.
// Everything is laid out from _matrixWidth/_matrixHeight and clamped, so it is
// safe on 64x32 / 128x32 / 64x64 / 128x64 (and degrades gracefully on anything
// smaller). When space is tight we drop the tagline first, then the glyph.
void Hub75Display::displaySplash()
{
    if (!_canvas)
        return;

    _canvas->fillScreen(0);

    const uint16_t color = textColor();
    const uint16_t accent = rgb565(90, 130, 200); // dimmer steel-blue for the glyph

    const int charW = 6, charH = 8; // 6x8 GFX font, unscaled
    const String wordmark = "FlightWall";
    const String tagline = "live flight tracker";

    // Pick the largest wordmark text size that fits the panel width, capped at 2.
    // Fall back to size 1 on narrow panels (e.g. 64-wide can't fit 10 glyphs at 2x).
    uint8_t ts = 1;
    if (_matrixWidth >= (int)wordmark.length() * charW * 2)
        ts = 2;
    const int wmW = (int)wordmark.length() * charW * ts;
    const int wmH = charH * ts;

    // Glyph and tagline are optional; include them only if the combined block fits
    // vertically. Glyph ~13px tall incl. spacing; tagline 8px + 2px gap.
    const int glyphH = 8, glyphGap = 3;   // vertical room a glyph adds above wordmark
    const int tagW = (int)tagline.length() * charW;
    const bool tagFits = (tagW <= _matrixWidth);

    // Decide what to include, dropping tagline then glyph until the block fits.
    bool showTag = tagFits;
    bool showGlyph = true;
    auto blockHeight = [&]() {
        int h = wmH;
        if (showGlyph)
            h += glyphH + glyphGap;
        if (showTag)
            h += charH + 2;
        return h;
    };
    if (blockHeight() > _matrixHeight)
        showTag = false;
    if (blockHeight() > _matrixHeight)
        showGlyph = false;

    int16_t y = (int16_t)((_matrixHeight - blockHeight()) / 2);
    if (y < 0)
        y = 0;

    // 1) Plane glyph (top-view silhouette) drawn from primitives, centered.
    if (showGlyph)
    {
        const int gw = 14, gh = glyphH;            // glyph bounding box
        int16_t gx = (int16_t)((_matrixWidth - gw) / 2);
        if (gx < 0)
            gx = 0;
        const int16_t cy = (int16_t)(y + gh / 2); // fuselage centerline
        // Fuselage (nose at right): a horizontal body with a pointed nose.
        _canvas->fillRect(gx + 2, cy - 1, 9, 2, accent);
        _canvas->fillTriangle(gx + 11, cy - 1, gx + 11, cy + 1, gx + 13, cy, accent);
        // Main wings (swept back) as two triangles meeting at the fuselage.
        _canvas->fillTriangle(gx + 6, cy, gx + 2, cy - 4, gx + 8, cy, accent);
        _canvas->fillTriangle(gx + 6, cy, gx + 2, cy + 4, gx + 8, cy, accent);
        // Tailplane (small fins near the tail at the left).
        _canvas->fillTriangle(gx + 3, cy, gx + 1, cy - 2, gx + 4, cy, accent);
        _canvas->fillTriangle(gx + 3, cy, gx + 1, cy + 2, gx + 4, cy, accent);
        y += gh + glyphGap;
    }

    // 2) Wordmark, horizontally centered.
    {
        int16_t wx = (int16_t)((_matrixWidth - wmW) / 2);
        if (wx < 0)
            wx = 0;
        _canvas->setTextSize(ts);
        drawTextLine(wx, y, wordmark, color);
        _canvas->setTextSize(1);
        y += wmH;
    }

    // 3) Tagline (dimmer), horizontally centered, if it still fits.
    if (showTag)
    {
        int16_t txx = (int16_t)((_matrixWidth - tagW) / 2);
        if (txx < 0)
            txx = 0;
        drawTextLine(txx, y + 2, tagline, accent);
    }

    present();
}

void Hub75Display::displayMessage(const String &message)
{
    if (!_canvas)
        return;

    _canvas->fillScreen(0);

    const int charWidth = 6;
    const int charHeight = 6;
    const int lineSpacing = 3;
    const int maxCols = _matrixWidth / charWidth;

    // Split on '\n' so a caller can pass several lines. It used to render one
    // truncated line, which silently cut its only real caller: "Setup: " plus
    // the AP name is 23 characters against the 21 that fit, so the setup screen
    // read "Setup: FlightWall-Set" -- a network name that does not exist.
    std::vector<String> lines;
    int start = 0;
    while (start <= (int)message.length())
    {
        int nl = message.indexOf('\n', start);
        if (nl < 0)
        {
            lines.push_back(message.substring(start));
            break;
        }
        lines.push_back(message.substring(start, nl));
        start = nl + 1;
    }

    const int n = (int)lines.size();
    const int blockH = n * charHeight + (n - 1) * lineSpacing;
    int16_t y = (int16_t)((_matrixHeight - blockH) / 2);
    if (y < 0)
        y = 0;

    for (const String &ln : lines)
    {
        drawTextLine(0, y, truncateToColumns(ln, maxCols), textColor());
        y += (int16_t)(charHeight + lineSpacing);
    }
    present();
}

void Hub75Display::showLoading()
{
    displayLoadingScreen();
}
