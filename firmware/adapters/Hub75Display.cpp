/*
Purpose: Render flight info on a HUB75 RGB LED matrix.
Responsibilities:
- Initialize the panel from runtime Settings (geometry/brightness) and the
  compile-time HUB75 pin map (HardwareConfiguration).
- Compose each frame into an in-RAM GFXcanvas16, then blit it to the panel; the
  same canvas backs framebuffer() for the web preview.
- Render a Mini-style flight card (airline logo tile + flight #, route, aircraft,
  and the configured metrics), cycling through multiple flights.
Inputs: FlightInfo list; g_settings (colors/brightness/layout/cycle/geometry).
*/
#include "adapters/Hub75Display.h"

#include <Adafruit_GFX.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <LittleFS.h>
#include <time.h>
#include "esp_heap_caps.h"
#include "config/HardwareConfiguration.h"
#include "config/FunFacts.h"
#include "core/Settings.h"
#include "utils/ClockFormat.h"

// How long each fun fact stays up / how long the clock<->fact alternation holds,
// in milliseconds. Reused as the clock recompose granularity is per-minute.
static const unsigned long kNoFlightsRotateMs = 7000UL;

static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b)
{
    return ((uint16_t)(r & 0xF8) << 8) | ((uint16_t)(g & 0xFC) << 3) | (b >> 3);
}

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
    _panel = new MatrixPanel_I2S_DMA(mxconfig);
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

const uint16_t *Hub75Display::framebuffer(uint16_t &w, uint16_t &h) const
{
    if (!_canvas)
    {
        w = 0;
        h = 0;
        return nullptr;
    }
    w = _matrixWidth;
    h = _matrixHeight;
    return _canvas->getBuffer();
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
    if (isnan(altFt))
        return String("");
    long ft = (long)(altFt + 0.5);
    if (ft >= 18000)
        return String("FL") + String((long)((ft + 50) / 100));
    return String(ft) + "ft";
}

static String formatHeading(double deg)
{
    if (isnan(deg))
        return String("");
    long d = ((long)(deg + 0.5)) % 360;
    if (d < 0)
        d += 360;
    char buf[8];
    snprintf(buf, sizeof(buf), "HDG%03ld", d);
    return String(buf);
}

static String formatVerticalRate(double fpm)
{
    if (isnan(fpm))
        return String("");
    if (fabs(fpm) <= 2.0) // direction-only indicator (Flights mode)
    {
        if (fpm > 0)
            return String("CLB");
        if (fpm < 0)
            return String("DES");
        return String("LVL");
    }
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
        String type = f.aircraft_display_name_short.length() ? f.aircraft_display_name_short : f.aircraft_code;
        if (type.length())
            outLines.push_back(type);
    }

    if (L.showAltitude)
    {
        String a = formatAltitude(f.altitude_ft);
        if (a.length())
            outLines.push_back(a);
    }

    if (L.showSpeed && !isnan(f.groundspeed_kt))
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

    // put() takes the value by const&, so insert an empty shell and move the
    // decoded pixels into it — no transient second copy of the tile.
    _logoCache.put(key, LogoTile{});
    LogoTile *slot = _logoCache.find(key); // just inserted -> MRU, never null
    *slot = std::move(tile);
    return slot;
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

    String code = f.operator_iata.length() ? f.operator_iata
                  : (f.operator_icao.length() ? f.operator_icao : f.operator_code);
    code = code.substring(0, 2);
    code.toUpperCase();
    String key = f.operator_icao.length() ? f.operator_icao : code;

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

void Hub75Display::displayFlightCard(const FlightInfo &f)
{
    if (_matrixHeight >= 48 && _matrixWidth >= 96)
        displayMiniCard(f); // big panel (e.g. 128x64): logo + 3 info lines + 2 metric rows
    else if (_matrixHeight < 16)
        displayTextOnlyCard(f); // too short for a logo
    else if (_matrixWidth >= _matrixHeight * 2)
        displaySideBySideCard(f); // wide & short (128x32, 160x32, 64x32)
    else
        displayStackedCard(f); // square / tall (64x64)
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
    if (isnan(ft))
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
    if (isnan(kt))
        return String("");
    return String((long)(kt * 1.15078 + 0.5)) + (unit ? "mph" : "");
}

static String miniTrk(double deg, bool unit)
{
    if (isnan(deg))
        return String("");
    long d = ((long)(deg + 0.5)) % 360;
    if (d < 0)
        d += 360;
    return String(d) + (unit ? "deg" : "");
}

static String miniVr(double fpm, bool unit)
{
    if (isnan(fpm))
        return String("");
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

    String airline = f.airline_display_name_full.length() ? f.airline_display_name_full
                     : (f.operator_iata.length() ? f.operator_iata
                        : (f.operator_icao.length() ? f.operator_icao : f.operator_code));
    String route = iataRoute(f);
    String type = f.aircraft_display_name_short.length() ? f.aircraft_display_name_short : f.aircraft_code;
    airline = airlineNameOverride(f.operator_icao, airline);
    if (!airline.length())
        airline = f.ident.length() ? f.ident : String("?");
    // When a real logo tile is shown, the "Airlines/Airways" suffix is redundant.
    // drawLogoOrBadge() above set _lastDrewLogo for exactly this flight's tile.
    if (_lastDrewLogo)
        airline = stripAirlineWords(airline);

    drawTextLine(tx, topY, truncateToColumns(airline, topCols), color);
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
    // ETA takes the trailing slot on row 2 ahead of the flight-number/Vr
    // choice below, INSTEAD of appending as a third item -- Trk plus a
    // typical 7-8 char ADS-B callsign already uses 18-19 of botCols'
    // 21 columns at 128px, so adding "ETA:~1h05" (9 chars) alongside both
    // would overflow by a wide margin in the ordinary case, not just a
    // pathological one. Worst realistic case with the mutually-exclusive
    // choice below, botCols=21 at 128px:
    //   unit=true:  "Trk:230deg"(10) + " " + "ETA:LANDING"(11) = 22 -- over by 1,
    //               falls through to the unit=false rebuild below
    //   unit=false: "Trk:230"(7)     + " " + "ETA:LANDING"(11) = 19 -- fits
    // "LANDING" is eta_text's longest realistic value (formatEta() also
    // emits "~Nm" <=4 chars and "~HhMM" <=6 chars for any plausible flight
    // time); eta_text has no unit suffix to drop, so unit only affects Trk's
    // "deg" here, same as it always did. eta_text is empty for every
    // OpenSky/adsb.lol flight and any server flight with no destination, so
    // this preempts the flight number only for server-sourced flights that
    // resolved a route -- exactly the flights for which "when does it land"
    // is the more useful of the two.
    //
    // This mutual-exclusion trick works for THREE candidates (ETA, flight
    // number, Vr) sharing one slot; the arithmetic above is hand-verified
    // for exactly that shape. A fourth candidate wanting this row is the
    // moment to stop extending this if/else-if chain and instead fill the
    // row from an ordered (label, value, priority) list against the column
    // budget -- the same "reconsider the structure, not another conditional"
    // point FlightDataFetcher.cpp's fetchFlights() notes for its own dispatch.
    auto buildRow2 = [&](bool unit)
    {
        String r;
        if (L.showHeading)
        {
            String t = miniTrk(f.heading_deg, unit);
            if (t.length())
                r = "Trk:" + t;
        }
        if (L.showEta && f.eta_text.length())
        {
            r += (r.length() ? " " : "") + String("ETA:") + f.eta_text;
        }
        else if (L.flightNumberOverVr)
        {
            String flt = f.ident.length() ? f.ident : f.ident_icao;
            if (flt.length())
                r += (r.length() ? " " : "") + flt;
        }
        else if (L.showVerticalRate)
        {
            String v = miniVr(f.vertical_rate_fpm, unit);
            if (v.length())
                r += (r.length() ? " " : "") + String("Vr:") + v;
        }
        return r;
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
    _canvas->drawLine(sepX, 1, sepX, _matrixHeight - 2,
                      accentColorFor(f.operator_icao.length() ? f.operator_icao : f.operator_code));

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

// Frame key for the active no-flights mode: a value that changes exactly when
// the screen should redraw. Returns -1 for the static "dots" mode (never
// animates). For clock: the current local minute-of-day (updates each minute).
// For funfact: the rotating fact index. For clockfact: combine the alternation
// phase with whichever sub-screen is active.
long Hub75Display::noFlightsFrameKey()
{
    const String &mode = g_settings.layout.noFlightsMode;
    const bool wantClock = (mode == "clock" || mode == "clockfact");
    const bool wantFact = (mode == "funfact" || mode == "clockfact");
    if (!wantClock && !wantFact)
        return -1; // "dots" (or unknown) -> static

    long key = 0;
    if (mode == "clockfact")
    {
        // Alternate every rotate interval; key must move on each phase flip and
        // on the underlying clock-minute / fact rotation.
        const long phase = (long)((millis() / kNoFlightsRotateMs) % 2);
        key = phase * 1000000L;
    }

    if (wantClock && (mode != "clockfact" || (millis() / kNoFlightsRotateMs) % 2 == 0))
    {
        time_t now = time(nullptr);
        if (now < 100000) // not synced -> fall back to fact rotation / dots
            key += (long)((millis() / kNoFlightsRotateMs) % (kFunFactCount ? kFunFactCount : 1));
        else
        {
            struct tm tmv;
            localtime_r(&now, &tmv); // TZ-aware (configTzTime); DST included
            key += (long)tmv.tm_hour * 60L + tmv.tm_min; // minute of day
        }
    }
    else // fun fact (funfact mode, or clockfact on the fact phase)
    {
        key += (long)((millis() / kNoFlightsRotateMs) % (kFunFactCount ? kFunFactCount : 1));
    }
    return key;
}

// Dispatch the no-flights screen by the configured mode. Composes onto the
// canvas and presents. Falls back to the dots/loading screen for "dots",
// unknown values, or when a clock is requested but time isn't synced yet.
void Hub75Display::displayNoFlights()
{
    const String &mode = g_settings.layout.noFlightsMode;
    bool showClock = false, showFact = false;
    if (mode == "clock")
        showClock = true;
    else if (mode == "funfact")
        showFact = true;
    else if (mode == "clockfact")
    {
        if ((millis() / kNoFlightsRotateMs) % 2 == 0)
            showClock = true;
        else
            showFact = true;
    }

    if (showClock)
    {
        if (time(nullptr) >= 100000)
        {
            drawClockScreen();
            return;
        }
        // Clock requested but not synced: in clockfact, show a fact instead; in
        // plain clock mode, fall back to the dots screen.
        if (mode == "clockfact")
            showFact = true;
        else
        {
            displayLoadingScreen();
            return;
        }
    }

    if (showFact)
    {
        drawFunFactScreen();
        return;
    }

    displayLoadingScreen(); // "dots" / unknown
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
void Hub75Display::drawFunFactScreen()
{
    if (kFunFactCount == 0)
    {
        displayLoadingScreen();
        return;
    }
    const uint16_t color = textColor();
    const size_t idx = (size_t)((millis() / kNoFlightsRotateMs) % kFunFactCount);
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

    const int innerWidth = _matrixWidth;
    const int maxCols = innerWidth / charWidth;
    String line = truncateToColumns(message, maxCols);

    const int16_t x = 0;
    const int16_t y = (_matrixHeight - charHeight) / 2;
    drawTextLine(x, y, line, textColor());
    present();
}

void Hub75Display::showLoading()
{
    displayLoadingScreen();
}
