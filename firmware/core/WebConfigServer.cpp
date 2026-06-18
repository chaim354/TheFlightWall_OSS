/*
Purpose: Implementation of the on-device configuration & control web server.
*/
#include "core/WebConfigServer.h"
#include "core/Settings.h"
#include "adapters/GeoLocator.h"

#include <LittleFS.h>
#include <WiFi.h>
#include <ArduinoJson.h>

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
    _server.on("/api/framebuffer", HTTP_GET, [this]()
               { handleFramebuffer(); });
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
    File f = LittleFS.open("/index.html", "r");
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
            o["airline"] = f.airline_display_name_full;
            o["aircraft"] = f.aircraft_display_name_short.length() ? f.aircraft_display_name_short : f.aircraft_code;
            o["origin"] = f.origin.code_icao;
            o["destination"] = f.destination.code_icao;
            o["helicopter"] = f.is_helicopter;
            if (f.has_metrics)
            {
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

void WebConfigServer::handleFramebuffer()
{
    uint16_t w = 0, h = 0;
    const uint16_t *fb = _display ? _display->framebuffer(w, h) : nullptr;
    if (!fb || w == 0 || h == 0)
    {
        _server.send(503, "application/octet-stream", "");
        return;
    }

    // Body: 4-byte header (w, h little-endian) + w*h little-endian RGB565 pixels.
    const size_t pxBytes = (size_t)w * (size_t)h * sizeof(uint16_t);
    uint8_t hdr[4] = {(uint8_t)(w & 0xFF), (uint8_t)(w >> 8),
                      (uint8_t)(h & 0xFF), (uint8_t)(h >> 8)};

    _server.setContentLength(sizeof(hdr) + pxBytes);
    _server.send(200, "application/octet-stream", "");

    WiFiClient client = _server.client();
    client.write(hdr, sizeof(hdr));
    client.write((const uint8_t *)fb, pxBytes); // ESP32 is little-endian: bytes match RGB565 LE
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
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (int i = 0; i < n && i < 20; ++i)
    {
        JsonObject o = arr.createNestedObject();
        o["ssid"] = WiFi.SSID(i);
        o["rssi"] = WiFi.RSSI(i);
        o["secure"] = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
    }
    WiFi.scanDelete();
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
