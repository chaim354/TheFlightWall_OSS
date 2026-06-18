/*
Purpose: On-device configuration & control web server (replaces the mobile app).

Serves a single-page web UI from LittleFS (`/index.html`) and a small REST API
for reading/writing the runtime Settings, viewing live status, scanning WiFi, and
restarting. Works both on the home network (STA mode) and as a first-time setup
access point (AP mode) with a captive-portal DNS redirect.

REST API:
  GET  /api/settings   -> current settings JSON
  POST /api/settings   -> apply + persist settings JSON (body)
  GET  /api/status     -> connection + device status JSON
  GET  /api/flights    -> currently displayed flights JSON (set by main loop)
  GET  /api/wifiscan   -> nearby WiFi networks JSON
  POST /api/restart    -> reboot the device
*/
#pragma once

#include <Arduino.h>
#include <utility>
#include <vector>
#include <WebServer.h>
#include <DNSServer.h>
#include "interfaces/BaseDisplay.h"
#include "models/FlightInfo.h"

class WebConfigServer
{
public:
    WebConfigServer();

    void begin(bool apMode, const String &ipAddress);
    void handle(); // call frequently from loop()

    // Pushed in from the main loop so the UI can show what's on the wall.
    // We store a pointer to the long-lived global flights vector and serialize
    // it on demand in handleGetFlights(), rather than re-serializing every fetch.
    void setFlights(const std::vector<FlightInfo> *flights) { _flights = flights; }
    void setLastFetchInfo(int flightCount, const String &note);

    // Display whose framebuffer is served as a live preview (/api/framebuffer).
    void setDisplay(BaseDisplay *display) { _display = display; }

    // Latest ambient light reading, surfaced in /api/status for calibration.
    void setLightStatus(int level, bool dark)
    {
        _lightLevel = level;
        _lightDark = dark;
    }

    // One-shot flags consumed by the main loop.
    bool consumeSettingsChanged();
    bool consumeRestartRequested();

private:
    WebServer _server;
    DNSServer _dns;
    bool _apMode = false;
    String _ip;
    const std::vector<FlightInfo> *_flights = nullptr;
    int _lastFlightCount = 0;
    String _lastNote;
    BaseDisplay *_display = nullptr;
    int _lightLevel = -1;
    bool _lightDark = false;

    volatile bool _settingsChanged = false;
    volatile bool _restartRequested = false;

    void registerRoutes();
    void handleGetSettings();
    void handlePostSettings();
    void handleGetStatus();
    void handleGetFlights();
    String buildFlightsJson() const;
    void handleFramebuffer();
    void handleGeolocate();
    void handleWifiScan();
    void handleRestart();
    void handleRoot();
    void handleNotFound();
};
