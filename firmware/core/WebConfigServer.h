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

Plus a deliberately dumb pair of routes for first-time provisioning:
  GET  /setup          -> ~1KB no-JavaScript WiFi form
  POST /setup          -> apply credentials from that form, then reboot

These exist because `/` cannot be relied on in the one situation it matters
most. The single-page UI is ~11KB gzipped and does everything through
fetch(), and the browser that opens on joining an open network is a
restricted captive-portal WebView that may limit scripting and can close
mid-flow -- over an AP link on a radio the panel is already degrading. In AP
mode the captive-portal redirect therefore points at /setup, not /.
*/
#pragma once

#include <Arduino.h>
#include <utility>
#include <vector>
#include <WebServer.h>
#include <DNSServer.h>
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
    // Note only. The flight COUNT is no longer pushed: it is derived from the
    // same vector /api/flights serialises, so the two cannot disagree.
    void setLastNote(const String &note);
    /** The same string /api/status reports, so the remote check-in describes
     * the wall identically to the LAN page rather than approximately. */
    const String &lastNote() const { return _lastNote; }
    // FlightDataFetcher::lastFetchStale() from the most recent cycle: the
    // FlightWall server served schedule or position data from cache after a
    // provider failure. Flights still render normally either way -- this is
    // surfaced only so the web UI can show it, not to change any behavior.
    void setServerStale(bool stale) { _serverStale = stale; }
    /** The source that actually produced the last flights; see
     *  FlightDataFetcher::lastActiveSource() for why it is not `positionSource`. */
    void setActiveSource(const String &src) { _activeSource = src; }
    void setSourceFallback(bool f) { _sourceFallback = f; }

    // Latest ambient light reading, surfaced in /api/status for calibration.
    // The RESOLVED panel state, after every override has been folded in.
    //
    // Diagnostic, and it earned its place: the panel went dark with every
    // configured source saying "lit" -- schedule on a day hour at brightness
    // 20, sensor disabled, base brightness 20 -- because a button had toggled
    // it off. That flag lives only in main.cpp's RAM, so /api/status showed
    // nothing capable of explaining a dark panel, and the only reachable
    // diagnosis was "everything says lit, yet fetch is paused". A wall-mounted
    // board has no other channel; this is the one.
    void setPanelState(int appliedBrightness, bool panelOff, int manualBrightness)
    {
        _panelBrightness = appliedBrightness;
        _panelOff = panelOff;
        _manualBrightness = manualBrightness;
    }

    void setLightStatus(int level, bool dark)
    {
        _lightLevel = level;
        _lightDark = dark;
    }

    // Why the last over-the-air update did not happen. Empty when none has
    // been attempted since boot, or when one succeeded (success reboots, so it
    // is never observed).
    //
    // It earned its place the same way setPanelState did: on 2026-08-25 an OTA
    // failed twice with the reason printed ONLY to Serial, and the wall is
    // wall-mounted with no cable in it. From the network the two attempts were
    // indistinguishable from a device that had ignored the command -- the
    // image, the signature, the partition and the server were each ruled out
    // by elimination before a USB cable finally produced `download failed
    // (-11)`. That string is the whole diagnosis, and it should never again
    // require going to the wall to read it.
    // Why the chip last restarted; see resetReasonText() in main.cpp for why
    // this is the field that separates a brownout from a crash.
    void setResetReason(const char *r) { _resetReason = r; }
    void setLastOtaError(const String &err) { _lastOtaError = err; }
    const String &lastOtaError() const { return _lastOtaError; }

    // One-shot flags consumed by the main loop.
    bool consumeSettingsChanged();
    bool consumeRestartRequested();

private:
    WebServer _server;
    DNSServer _dns;
    bool _apMode = false;
    String _ip;
    const std::vector<FlightInfo> *_flights = nullptr;
    String _lastNote;
    bool _serverStale = false;
    String _activeSource;
    bool _sourceFallback = false;
    int _lightLevel = -1;
    bool _lightDark = false;
    String _lastOtaError;
    String _resetReason;
    int _panelBrightness = -1;   // resolved, -1 until the first applyBrightness()
    bool _panelOff = false;      // the button-A toggle
    int _manualBrightness = -1;  // a button ramp, -1 when none is in force

    volatile bool _settingsChanged = false;
    volatile bool _restartRequested = false;

    void registerRoutes();
    void handleGetSettings();
    void handlePostSettings();
    void handleGetStatus();
    void handleGetFlights();
    String buildFlightsJson() const;
    void handleGeolocate();
    void handleWifiScan();
    void handleRestart();
    void handleRoot();
    void handleSetupPage(const char *banner);
    void appendScanList(String &html);
    void handleUpdateUi();
    void handleClearUi();
    void handleFirmwareCheck();
    void handleFirmwareApply();
    void handleSetupGet();
    void handleSetupPost();
    void handleNotFound();
};
