/*
Purpose: Implementation of the on-device configuration & control web server.
*/
#include "core/WebConfigServer.h"
#include "core/Settings.h"
#include "config/HardwareConfiguration.h" // board-guarded pins reported in /api/status
#include "adapters/GeoLocator.h"

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

void WebConfigServer::setLastFetchInfo(int flightCount, const String &note)
{
    _lastFlightCount = flightCount;
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
    _server.send(200, "application/json", g_settings.toJson());
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
    doc["flightCount"] = _lastFlightCount;
    doc["note"] = _lastNote;
    doc["freeHeap"] = (uint32_t)ESP.getFreeHeap();
    doc["lightLevel"] = _lightLevel;
    doc["lightDark"] = _lightDark;
    // Board-specific pins so the (single, board-agnostic) web UI can label the light
    // sensor controls truthfully. Hardcoding them in index.html got it wrong on the
    // S3, which has no GPIO 22 and whose ADC1 is 1-10 rather than 32-39.
    doc["i2cSda"] = HardwareConfiguration::I2C_SDA;
    doc["i2cScl"] = HardwareConfiguration::I2C_SCL;
    doc["adc1Min"] = HardwareConfiguration::ADC1_PIN_MIN;
    doc["adc1Max"] = HardwareConfiguration::ADC1_PIN_MAX;
    doc["buttonAPin"] = HardwareConfiguration::BUTTON_A_PIN;
    doc["buttonBPin"] = HardwareConfiguration::BUTTON_B_PIN;
    String out;
    serializeJson(doc, out);
    _server.send(200, "application/json", out);
}

// Prefer IATA, fall back to ICAO — the rule AirportInfo documents as the display code,
// and the same one iataRoute() applies when drawing the panel.
static String displayCode(const AirportInfo &a)
{
    return a.code_iata.length() ? a.code_iata : a.code_icao;
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
            // airline_display_name_full, so under Flightradar24 — whose inline route data
            // makes those lookups unnecessary and skipped — this was always the empty
            // string and the card's airline column rendered blank, even though the wall
            // knew the operator well enough to draw its logo.
            o["airline"] = f.airline_display_name_full.length() ? f.airline_display_name_full
                           : (f.operator_iata.length() ? f.operator_iata
                              : (f.operator_icao.length() ? f.operator_icao : f.operator_code));
            o["aircraft"] = f.aircraft_display_name_short.length() ? f.aircraft_display_name_short : f.aircraft_code;
            // Reading code_icao alone blanked this list for any source that supplies only
            // IATA — which is every flight under Flightradar24, whose feed carries IATA
            // origin/destination inline and no ICAO at all. The UI renders these as
            // `${x.origin||'?'}`, so the card showed "? → ?" for traffic the panel beside
            // it was displaying correctly. Under OpenSky/adsbdb both codes are populated,
            // so this also switches the list from KJFK to JFK and matches the wall.
            o["origin"] = displayCode(f.origin);
            o["destination"] = displayCode(f.destination);
            o["helicopter"] = f.is_helicopter;
            o["cargo"] = f.is_cargo;
            o["private"] = f.is_private;
            if (f.has_metrics)
            {
                // Distance from the configured center — the key the list is already
                // ordered by (FlightDataFetcher sorts candidates nearest-first). NAN in
                // Flights mode, which has no center to measure from, so the guard omits
                // the key there rather than emitting null.
                if (!isnan(f.distance_km))
                    o["distanceKm"] = round(f.distance_km * 10.0) / 10.0;
                if (!isnan(f.altitude_ft))
                    o["altitudeFt"] = (long)f.altitude_ft;
                if (!isnan(f.groundspeed_kt))
                    o["speedKt"] = (long)f.groundspeed_kt;
                if (!isnan(f.heading_deg))
                    o["headingDeg"] = (long)f.heading_deg;
                if (!isnan(f.vertical_rate_fpm))
                    o["verticalRateFpm"] = (long)f.vertical_rate_fpm;
            }
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

void WebConfigServer::handleNotFound()
{
    // In AP/captive-portal mode, send unknown hosts to the config page.
    if (_apMode)
    {
        _server.sendHeader("Location", String("http://") + _ip + "/", true);
        _server.send(302, "text/plain", "");
        return;
    }
    handleRoot();
}
