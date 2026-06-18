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
#include "esp_heap_caps.h"
#include "config/HardwareConfiguration.h"
#include "core/Settings.h"

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
    if (_logoPixels)
    {
        delete[] _logoPixels;
        _logoPixels = nullptr;
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
    return true;
}

void Hub75Display::present()
{
    if (_panel && _canvas)
        _panel->drawRGBBitmap(0, 0, _canvas->getBuffer(), _matrixWidth, _matrixHeight);
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
        String origin = f.origin.code_icao;
        String dest = f.destination.code_icao;
        if (origin.length() || dest.length())
            outLines.push_back(origin + ">" + dest);
    }

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

bool Hub75Display::loadLogoFor(const String &icao)
{
    if (icao.length() == 0)
        return false;
    if (icao == _logoIcao)
        return _logoValid; // cached

    _logoIcao = icao;
    _logoValid = false;
    if (_logoPixels)
    {
        delete[] _logoPixels;
        _logoPixels = nullptr;
    }

    String path = String("/logos/") + icao + ".rgb565";
    File f = LittleFS.open(path, "r");
    if (!f)
        return false;

    uint8_t hdr[4];
    if (f.read(hdr, 4) != 4)
    {
        f.close();
        return false;
    }
    int w = hdr[0] | (hdr[1] << 8);
    int h = hdr[2] | (hdr[3] << 8);
    if (w <= 0 || h <= 0 || w > 64 || h > 64)
    {
        f.close();
        return false;
    }

    size_t count = (size_t)w * (size_t)h;
    _logoPixels = new uint16_t[count];
    size_t want = count * sizeof(uint16_t);
    size_t got = f.read((uint8_t *)_logoPixels, want); // stored little-endian == ESP32 native
    f.close();
    if (got != want)
    {
        delete[] _logoPixels;
        _logoPixels = nullptr;
        return false;
    }
    _logoW = w;
    _logoH = h;
    _logoValid = true;
    return true;
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
    bool haveLogo = false;
    if (f.is_helicopter)
        haveLogo = loadLogoFor("_HELI") && _logoValid;
    else if (f.is_private)
        haveLogo = loadLogoFor("_PRIVATE") && _logoValid;
    if (!haveLogo && f.operator_icao.length())
        haveLogo = loadLogoFor(f.operator_icao) && _logoValid;
    if (!haveLogo && f.is_cargo)
        haveLogo = loadLogoFor("_CARGO") && _logoValid;
    if (haveLogo)
    {
        // Integer-scale the native tile to fill the box (1x for a 32px tile in a
        // 32px box, 2x for a 16px tile, etc.).
        int scale = min(w / _logoW, h / _logoH);
        if (scale < 1)
            scale = 1;
        const int16_t sw = _logoW * scale, sh = _logoH * scale;
        const int16_t lx = x + (w - sw) / 2;
        const int16_t ly = y + (h - sh) / 2;
        if (scale == 1)
        {
            _canvas->drawRGBBitmap(lx, ly, _logoPixels, _logoW, _logoH);
        }
        else
        {
            for (int j = 0; j < _logoH; ++j)
                for (int i = 0; i < _logoW; ++i)
                    _canvas->fillRect(lx + i * scale, ly + j * scale, scale, scale,
                                      _logoPixels[j * _logoW + i]);
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
    String o = f.origin.code_iata.length() ? f.origin.code_iata : f.origin.code_icao;
    String d = f.destination.code_iata.length() ? f.destination.code_iata : f.destination.code_icao;
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
    if (_logoValid)
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
    auto buildRow2 = [&](bool unit)
    {
        String r;
        if (L.showHeading)
        {
            String t = miniTrk(f.heading_deg, unit);
            if (t.length())
                r = "Trk:" + t;
        }
        if (L.flightNumberOverVr)
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
    if (indexToShow == _lastComposedIndex && _dataVersion == _lastComposedVersion)
        return;

    _lastComposedIndex = indexToShow;
    _lastComposedVersion = _dataVersion;

    // 3) Compose the card (or loading screen for an empty list).
    _canvas->fillScreen(0);

    if (indexToShow != SIZE_MAX)
    {
        displayFlightCard(flights[indexToShow]);
    }
    else
    {
        displayLoadingScreen();
        return; // displayLoadingScreen presents already
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
