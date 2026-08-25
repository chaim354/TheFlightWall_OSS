/*
Purpose: Implementation of the on-device configuration & control web server.
*/
#include "core/WebConfigServer.h"
#include "esp_heap_caps.h"
#include "core/Settings.h"
#include "utils/HtmlEscape.h"
#include "config/HardwareConfiguration.h" // board-guarded pins reported in /api/status
#include "adapters/GeoLocator.h"
#include "utils/ServerJson.h" // renderable()

#include <LittleFS.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <algorithm>
#include <vector>

static const byte kDnsPort = 53;

WebConfigServer::WebConfigServer() : _server(80) {}

void WebConfigServer::begin(bool apMode, const String &ipAddress)
{
    _apMode = apMode;
    _ip = ipAddress;

    registerRoutes();

    if (_apMode)
    {
        // Captive portal: route every hostname back to us.
        _dns.start(kDnsPort, "*", WiFi.softAPIP());
    }

    _server.begin();
    Serial.print("WebConfigServer: listening at http://");
    Serial.println(_ip);
}

void WebConfigServer::handle()
{
    if (_apMode)
        _dns.processNextRequest();
    _server.handleClient();
}

bool WebConfigServer::consumeSettingsChanged()
{
    if (_settingsChanged)
    {
        _settingsChanged = false;
        return true;
    }
    return false;
}

bool WebConfigServer::consumeRestartRequested()
{
    if (_restartRequested)
    {
        _restartRequested = false;
        return true;
    }
    return false;
}

void WebConfigServer::setLastNote(const String &note)
{
    _lastNote = note;
}

void WebConfigServer::registerRoutes()
{
    _server.on("/", HTTP_GET, [this]()
               { handleRoot(); });
    _server.on("/api/settings", HTTP_GET, [this]()
               { handleGetSettings(); });
    _server.on("/api/settings", HTTP_POST, [this]()
               { handlePostSettings(); });
    _server.on("/api/status", HTTP_GET, [this]()
               { handleGetStatus(); });
    _server.on("/api/flights", HTTP_GET, [this]()
               { handleGetFlights(); });
    _server.on("/api/geolocate", HTTP_GET, [this]()
               { handleGeolocate(); });
    _server.on("/api/wifiscan", HTTP_GET, [this]()
               { handleWifiScan(); });
    _server.on("/api/restart", HTTP_POST, [this]()
               { handleRestart(); });
    _server.on("/setup", HTTP_GET, [this]()
               { handleSetupGet(); });
    _server.on("/setup", HTTP_POST, [this]()
               { handleSetupPost(); });
    _server.onNotFound([this]()
                       { handleNotFound(); });
}

void WebConfigServer::handleRoot()
{
    // Prefer the pre-compressed page (~25KB -> ~7.5KB). That matters more here than on
    // a normal server: loop() is single-threaded and blocks on the flight fetch, so the
    // page can only stream during the gaps — fewer bytes is directly less time stuck.
    // tools/gzip_web_assets.py regenerates the .gz on every build, so it cannot go
    // stale; the uncompressed fallback below covers an FS image built without it.
    // Do NOT sendHeader("Content-Encoding") here. streamFile() -> _streamFileCore()
    // already adds it when the FILE NAME ends in .gz (WebServer.cpp:525). Setting it
    // manually as well emits the header twice, which per HTTP means the body was
    // gzipped TWICE — the browser decodes once, tries again, fails, and renders
    // nothing. The content type stays text/html: that is what the decoded body is,
    // and it is also what triggers the automatic header.
    File f = LittleFS.open("/index.html.gz", "r");
    if (f)
    {
        _server.streamFile(f, "text/html");
        f.close();
        return;
    }

    f = LittleFS.open("/index.html", "r");
    if (!f)
    {
        _server.send(200, "text/html",
                     "<h1>FlightWall</h1><p>UI asset missing. Upload the LittleFS "
                     "filesystem image (index.html) and reboot.</p>");
        return;
    }
    _server.streamFile(f, "text/html");
    f.close();
}

void WebConfigServer::handleGetSettings()
{
    // REDACTED projection: this endpoint is unauthenticated and reachable by any
    // LAN peer. save() still persists the full document via toJson().
    _server.send(200, "application/json", g_settings.toJsonPublic());
}

void WebConfigServer::handlePostSettings()
{
    if (!_server.hasArg("plain"))
    {
        _server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing body\"}");
        return;
    }
    String body = _server.arg("plain");
    if (!g_settings.fromJson(body))
    {
        _server.send(400, "application/json", "{\"ok\":false,\"error\":\"invalid json\"}");
        return;
    }
    bool saved = g_settings.save();
    _settingsChanged = true;
    String resp = String("{\"ok\":") + (saved ? "true" : "false") + "}";
    _server.send(saved ? 200 : 500, "application/json", resp);
}

void WebConfigServer::handleGetStatus()
{
    JsonDocument doc;
    doc["apMode"] = _apMode;
    doc["wifiConnected"] = (WiFi.status() == WL_CONNECTED);
    doc["ssid"] = _apMode ? WiFi.softAPSSID() : WiFi.SSID();
    doc["ip"] = _ip;
    doc["rssi"] = _apMode ? 0 : WiFi.RSSI();
    doc["mode"] = (g_settings.mode == TrackingMode::Flights) ? "flights" : "area";
    // Derived, not cached. This was a pushed int, and it went stale in a way that
    // mattered: main.cpp pushes the count on a failed fetch, then clears
    // g_lastFlights when they age out, and nothing re-pushes -- so /api/status
    // reported N flights while /api/flights returned []. With the backoff at its
    // 300s cap that contradiction persisted for five minutes, on the only
    // diagnostic channel a wall-mounted board has, at exactly the moment someone
    // is looking at it. (It misled a live diagnosis on 2026-08-23.) Reading the
    // same vector /api/flights serialises makes them agree by construction.
    doc["flightCount"] = _flights ? (int)_flights->size() : 0;
    doc["note"] = _lastNote;
    // FlightWall-server-only: schedule or position data was served from cache
    // after a provider failure on the last cycle. Always false off the server
    // source. Flights render normally either way -- informational only.
    doc["serverStale"] = _serverStale;
    doc["freeHeap"] = (uint32_t)ESP.getFreeHeap();
    // freeHeap ALONE is misleading, and it misled a live diagnosis: the device was
    // failing every fetch with ~174KB free, which reads healthy. What a TLS
    // handshake actually needs is a large CONTIGUOUS internal block -- the same
    // quantity PIXEL_COLOR_DEPTH_BITS=6 exists to widen (~40KB -> ~56KB, see
    // platformio.ini). Total free can stay flat while that block fragments away
    // underneath it, so report the block itself, not just the sum.
    //
    // main.cpp's logHeap() has printed these to serial all along; they were simply
    // unreachable over the network, which is the only channel available when the
    // board is mounted on a wall. Same three numbers, same calls.
    doc["largestInternal"] = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
    doc["largestDma"] = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_DMA);
    doc["freeInternal"] = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    doc["freePsram"] = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    doc["lightLevel"] = _lightLevel;
    doc["lightDark"] = _lightDark;
    // Why the panel looks the way it does, resolved rather than configured.
    // `panelBrightness` is applyBrightness()'s output -- 0 means dark for SOME
    // reason -- and the two fields under it name the reasons that exist only in
    // RAM and so appear nowhere in /api/settings.
    doc["panelBrightness"] = _panelBrightness;
    doc["panelOff"] = _panelOff;
    doc["manualBrightness"] = _manualBrightness;
    // Board-specific pins so the (single, board-agnostic) web UI can label the light
    // sensor controls truthfully. Hardcoding them in index.html got it wrong on the
    // S3, which has no GPIO 22 and whose ADC1 is 1-10 rather than 32-39.
    doc["i2cSda"] = HardwareConfiguration::I2C_SDA;
    doc["i2cScl"] = HardwareConfiguration::I2C_SCL;
    // The USABLE window, not the chip's full ADC1 range. index.html renders these
    // verbatim as "Analog pin (ADC1: <min>-<max>)", so publishing the raw range
    // advertised seven HUB75 data lines as valid choices on the S3 -- and
    // Settings.cpp accepts whatever is POSTed without validating it.
    doc["adc1Min"] = HardwareConfiguration::ADC1_FREE_MIN;
    doc["adc1Max"] = HardwareConfiguration::ADC1_FREE_MAX;
    doc["buttonAPin"] = HardwareConfiguration::BUTTON_A_PIN;
    doc["buttonBPin"] = HardwareConfiguration::BUTTON_B_PIN;
    String out;
    serializeJson(doc, out);
    _server.send(200, "application/json", out);
}

String WebConfigServer::buildFlightsJson() const
{
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    if (_flights)
    {
        for (const auto &f : *_flights)
        {
            JsonObject o = arr.createNestedObject();
            o["ident"] = f.ident.length() ? f.ident : f.ident_icao;
            // Same fallback chain buildFlightLines uses on the panel, and that the
            // aircraft line below already used here. Only the enrichment fetchers set
            // airline_display_name_full, so under Flightradar24 — which skips those
            // lookups only for flights whose row already carried a route — this was
            // often the empty string and the card's airline column rendered blank,
            // even though the wall knew the operator well enough to draw its logo.
            o["airline"] = f.airline_display_name_full.length() ? f.airline_display_name_full
                           : (f.operator_iata.length() ? f.operator_iata
                              : (f.operator_icao.length() ? f.operator_icao : f.operator_code));
            o["aircraft"] = f.aircraft_code;
            // Reading code_icao alone blanked this list for any source that supplies only
            // IATA — which is every flight under Flightradar24, whose feed carries IATA
            // origin/destination inline and no ICAO at all. The UI renders these as
            // `${x.origin||'?'}`, so the card showed "? → ?" for traffic the panel beside
            // it was displaying correctly. Under OpenSky/adsbdb both codes are populated,
            // so this also switches the list from KJFK to JFK and matches the wall.
            o["origin"] = f.origin.displayCode();
            o["destination"] = f.destination.displayCode();
            o["helicopter"] = f.is_helicopter;
            o["cargo"] = f.is_cargo;
            o["private"] = f.is_private;
            // Each field gates on its own value being present. There was an outer
            // `if (f.has_metrics)` here, but every guard below already asks the only
            // question that matters, so the gate could only ever suppress fields that
            // WERE present -- which it did: AeroAPI set has_metrics for
            // altitude/speed/heading and not for vertical rate, so a flight reporting
            // only altitude_change had its rate omitted here while the panel drew CLB.
            //
            // Distance from the configured center — the key the list is already
            // ordered by (FlightDataFetcher sorts candidates nearest-first). NAN in
            // Flights mode, which has no center to measure from, so the guard omits
            // the key there rather than emitting null.
            if (renderable(f.distance_km))
                o["distanceKm"] = round(f.distance_km * 10.0) / 10.0;
            if (renderable(f.altitude_ft))
                o["altitudeFt"] = (long)f.altitude_ft;
            if (renderable(f.groundspeed_kt))
                o["speedKt"] = (long)f.groundspeed_kt;
            if (renderable(f.heading_deg))
                o["headingDeg"] = (long)f.heading_deg;
            if (renderable(f.vertical_rate_fpm))
                o["verticalRateFpm"] = (long)f.vertical_rate_fpm;
            // eta_text/eta_minutes come only from the FlightWall server (empty/NAN
            // for every OpenSky/adsb.lol flight and any server flight with no
            // destination), so these are independent of the metrics above -- the
            // live list is the fastest way to see whether ETA is arriving at all
            // without staring at the panel. etaText is the server's pre-rounded
            // display string; etaMin is the unrounded minutes for debugging.
            if (f.eta_text.length())
                o["etaText"] = f.eta_text;
            if (!isnan(f.eta_minutes))
                o["etaMin"] = (long)f.eta_minutes;
        }
    }
    String out;
    serializeJson(doc, out);
    return out;
}

void WebConfigServer::handleGetFlights()
{
    _server.send(200, "application/json", buildFlightsJson());
}

void WebConfigServer::handleGeolocate()
{
    GeoLocator geo;
    double lat = 0, lon = 0;
    String place;
    if (geo.locate(lat, lon, place))
    {
        JsonDocument doc;
        doc["ok"] = true;
        doc["lat"] = lat;
        doc["lon"] = lon;
        doc["place"] = place;
        String out;
        serializeJson(doc, out);
        _server.send(200, "application/json", out);
    }
    else
    {
        _server.send(200, "application/json", "{\"ok\":false}");
    }
}

void WebConfigServer::handleWifiScan()
{
    int n = WiFi.scanNetworks();
    std::vector<int> idx;
    for (int i = 0; i < n; ++i)
        idx.push_back(i);
    // strongest first, so a strong-but-late network is never dropped by the cap
    std::sort(idx.begin(), idx.end(), [](int a, int b)
              { return WiFi.RSSI(a) > WiFi.RSSI(b); });

    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    std::vector<String> seen;
    const size_t cap = 40;
    for (int i : idx)
    {
        if (arr.size() >= cap)
            break;
        String ssid = WiFi.SSID(i);
        if (ssid.length() == 0)
            continue; // hidden/blank
        bool dup = false;
        for (auto &s : seen)
        {
            if (s == ssid)
            {
                dup = true;
                break;
            }
        }
        if (dup)
            continue; // dedupe band-steered SSIDs
        seen.push_back(ssid);
        JsonObject o = arr.createNestedObject();
        o["ssid"] = ssid;
        o["rssi"] = WiFi.RSSI(i);
        o["secure"] = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
    }
    WiFi.scanDelete(); // free scan results
    String out;
    serializeJson(doc, out);
    _server.send(200, "application/json", out);
}

void WebConfigServer::handleRestart()
{
    _server.send(200, "application/json", "{\"ok\":true}");
    _restartRequested = true;
}

// ~1KB, no script, no external asset, one form. Everything about this page is
// chosen for the browser it will actually be read in: the captive-portal sheet a
// phone opens when it joins an open network. That sheet is a stripped WebView
// which may restrict scripting, has no back button worth the name, and closes
// itself the moment the OS decides the network is "working" -- and here it is
// also talking over the setup AP, on a radio the HUB75 panel is degrading (see
// HANDOFF 1). Every byte and every round trip is a chance to lose the session,
// so this page has no <script>, no <img>, and no second request.
// Runs a scan and appends the results as links into `html`.
//
// Scanning needs the STA interface up, and in setup mode only the AP is. Going
// through AP_STA rather than STA keeps the access point serving the very page
// that asked for this -- switching to plain STA would tear it down and take the
// request with it. The interface is left enabled afterwards: flipping it back
// off is another radio transition for no benefit, and the next thing this page
// does is reboot into STA anyway.
void WebConfigServer::appendScanList(String &html)
{
    if (_apMode)
        WiFi.mode(WIFI_AP_STA);

    const int n = WiFi.scanNetworks();
    if (n <= 0)
    {
        html += F("<p><b>No networks found.</b> Type the name in below, or "
                  "<a href=\"/setup?scan=1\" style=\"color:#7bf\">scan again</a>.</p>");
        WiFi.scanDelete();
        return;
    }

    std::vector<int> idx;
    for (int i = 0; i < n; ++i)
        idx.push_back(i);
    std::sort(idx.begin(), idx.end(), [](int a, int b)
              { return WiFi.RSSI(a) > WiFi.RSSI(b); });

    html += F("<p>Tap a network to fill it in:</p><p style=\"line-height:2\">");
    std::vector<String> seen;
    for (int i : idx)
    {
        if (seen.size() >= 15) // a captive WebView is not the place for 40 rows
            break;
        String ssid = WiFi.SSID(i);
        if (ssid.length() == 0)
            continue; // hidden
        bool dup = false;
        for (auto &sn : seen)
            if (sn == ssid)
            {
                dup = true;
                break;
            }
        if (dup)
            continue; // band-steered duplicates
        seen.push_back(ssid);

        html += F("<a style=\"color:#7bf;display:block\" href=\"/setup?ssid=");
        appendUrlEncoded(html, ssid.c_str());
        html += F("\">");
        appendHtmlEscaped(html, ssid.c_str());
        html += (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? F(" (open)") : F("");
        html += F("</a>");
    }
    html += F("</p>");
    WiFi.scanDelete();
}

void WebConfigServer::handleSetupPage(const char *banner)
{
    String html;
    html.reserve(1400);
    html += F("<!doctype html><html><head><meta charset=utf-8>"
              "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
              "<title>FlightWall setup</title><style>"
              "body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1.5em;"
              "background:#111;color:#eee}h1{font-size:1.15em;margin:0 0 .8em}"
              "label{display:block;margin:1em 0 .3em;font-size:.9em}"
              "input{width:100%;box-sizing:border-box;padding:.7em;font-size:1em;"
              "border:1px solid #555;border-radius:5px;background:#222;color:#eee}"
              "button{margin-top:1.3em;width:100%;padding:.85em;font-size:1em;border:0;"
              "border-radius:5px;background:#2a8;color:#fff}"
              "p{color:#9a9a9a;font-size:.82em;line-height:1.4}"
              "b{color:#ffb454}</style></head><body><h1>FlightWall Wi-Fi setup</h1>");
    if (banner != nullptr)
    {
        html += F("<p><b>");
        appendHtmlEscaped(html, banner);
        html += F("</b></p>");
    }
    // action is relative on purpose. In AP mode the phone may have reached us
    // through the captive-portal redirect at 192.168.4.1, but on the LAN the
    // same page is served at the STA address and via flightwall.local -- an
    // absolute action would post the form back to the wrong host in two of
    // those three cases.
    // Network picker, server-rendered. No JavaScript on purpose: this page is
    // the one the captive-portal WebView has to cope with, and the whole reason
    // it is separate from "/" is that the WebView cannot be trusted with
    // fetch(). So "scan" is a plain link back to this page, and each result is
    // a plain link that prefills the field below.
    //
    // The scan is NOT free: it puts the radio on other channels for a couple of
    // seconds, and the AP's own beacons stop while that happens. On a device
    // whose association is already marginal that can drop the very client
    // asking for the list, which is why it happens only when someone asks.
    {
        const bool wantScan = _server.hasArg("scan");
        if (wantScan)
        {
            html += F("<p>Scanning...</p>");
            appendScanList(html);
        }
        else
        {
            html += F("<p><a href=\"/setup?scan=1\" style=\"color:#7bf\">Scan for networks</a>"
                      " &mdash; takes a few seconds, and the setup network drops out while it runs.</p>");
        }
    }

    html += F("<form method=POST action=\"/setup\">"
              "<label for=s>Network name</label>"
              "<input id=s name=ssid autocapitalize=none autocorrect=off spellcheck=false value=\"");
    // A picked network prefills the field; otherwise the stored SSID does.
    if (_server.hasArg("ssid"))
        appendHtmlEscaped(html, _server.arg("ssid").c_str());
    else
        appendHtmlEscaped(html, g_settings.wifiSsid.c_str());
    html += F("\"><label for=p>Password</label>"
              "<input id=p name=pw type=password autocapitalize=none autocorrect=off spellcheck=false>"
              "<p>Leave the password blank to keep the one already stored. "
              "The device restarts after saving and joins the network.</p>"
              "<button type=submit>Save and restart</button></form>"
              "<p><a href=\"/\" style=\"color:#7bf\">Full settings page</a></p>"
              "</body></html>");
    _server.send(200, "text/html", html);
}

void WebConfigServer::handleSetupGet()
{
    handleSetupPage(nullptr);
}

void WebConfigServer::handleSetupPost()
{
    String ssid = _server.arg("ssid");
    ssid.trim();
    if (ssid.length() == 0)
    {
        // Re-render rather than 400. This form's user is standing at a wall
        // panel with no network, inside a WebView whose back button may not
        // return them here -- an error page they cannot navigate away from
        // ends the setup session.
        handleSetupPage("Enter a network name.");
        return;
    }

    g_settings.wifiSsid = ssid;

    // An EMPTY password means "unchanged", matching Settings::fromJson -- see
    // the long comment there. The page says so out loud, because the field is
    // never pre-filled (the password is not served to any client) and a blank
    // box would otherwise read as "no password".
    const String pw = _server.arg("pw");
    if (pw.length() > 0)
        g_settings.wifiPassword = pw;

    const bool saved = g_settings.save();
    _settingsChanged = true;

    String html;
    html.reserve(700);
    html += F("<!doctype html><html><head><meta charset=utf-8>"
              "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
              "<title>FlightWall setup</title><style>"
              "body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1.5em;"
              "background:#111;color:#eee}p{line-height:1.5}b{color:#ffb454}"
              "</style></head><body>");
    if (saved)
    {
        html += F("<p>Saved. Restarting and joining <b>");
        appendHtmlEscaped(html, g_settings.wifiSsid.c_str());
        html += F("</b>.</p><p>This page will stop responding -- the setup network "
                  "is shutting down. Rejoin your normal Wi-Fi; the panel shows its "
                  "address once connected.</p>");
    }
    else
    {
        html += F("<p><b>Could not write settings.</b> Nothing was changed. "
                  "Reload and try again.</p>");
    }
    html += F("</body></html>");
    _server.send(saved ? 200 : 500, "text/html", html);

    // Only reboot on a successful write. Restarting after a failed save drops
    // the user's input AND the AP they were talking to, leaving them with no
    // way to find out that nothing was stored.
    if (saved)
        _restartRequested = true;
}

void WebConfigServer::handleNotFound()
{
    // In AP/captive-portal mode, send unknown hosts to the SETUP page, not to
    // "/". This is the probe a phone fires on joining an open network, so the
    // page it lands on is the one the captive-portal WebView has to render --
    // and that WebView is the worst browser in the house. /setup is ~1KB of
    // plain form with no script; "/" is ~11KB gzipped that does everything
    // through fetch(). Anyone who wants the full UI can still reach it, both
    // from the link on /setup and by typing the address.
    if (_apMode)
    {
        // Serve the form ITSELF, 200, rather than redirecting to it.
        //
        // This is the request a phone fires on joining an open network --
        // captive.apple.com/hotspot-detect.html on iOS/macOS, /generate_204 on
        // Android, /connecttest.txt on Windows -- and every one of them decides
        // "this network is captive" by getting back something OTHER than the
        // exact success response it expected. A 302 qualifies, and iOS does
        // follow it, but that is one extra round trip inside the captive
        // WebView before anything is on screen, on a device whose association
        // has already been slow. Answering with the page directly makes the
        // sheet open showing the form.
        //
        // No-store because a probe response that gets cached is a portal that
        // stops appearing on the next join -- and the client would then believe
        // it already has internet.
        _server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        _server.sendHeader("Pragma", "no-cache");
        handleSetupPage(nullptr);
        return;
    }
    handleRoot();
}
