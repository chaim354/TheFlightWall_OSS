/*
Purpose: Firmware entry point for ESP32 (FlightWall Mini parity build).

Boot flow:
- Mount LittleFS + load runtime Settings (or seed from compile-time defaults).
- Initialize the LED matrix display.
- Connect to WiFi (STA) using saved credentials; if none/failed, fall back to a
  setup Access Point ("FlightWall-Setup") so the user can configure over the web.
- Start the configuration & control web server (replaces the mobile app).
- Start NTP for the brightness scheduler.

Run loop:
- Service the web server (settings edits, status, WiFi scan, restart).
- Periodically fetch + enrich flights (Area or Flights mode) and render them.
- Apply scheduled brightness based on local time.
- React to settings changes / restart requests from the web UI.
*/
#include <vector>
#include <utility>
#include <time.h>
#include <WiFi.h>
// Direct includes so PlatformIO's LDF adds these bundled framework libraries to
// the build (it does not always follow them through project headers).
#include <WebServer.h>
#include <DNSServer.h>
#include <LittleFS.h>
#include <ESPmDNS.h>
#include <ArduinoJson.h>
#include "core/Settings.h"
#include "core/HttpJson.h"
#include "esp_heap_caps.h"
#include "adapters/OpenSkyFetcher.h"
#include "adapters/AeroAPIFetcher.h"
#include "adapters/AdsbdbFetcher.h"
#include "core/FlightDataFetcher.h"
#include "core/WebConfigServer.h"
#include "core/SerialConsole.h"
#include "adapters/Hub75Display.h"
#include "adapters/LightSensor.h"
#include "adapters/GeoLocator.h"

static HttpJson g_http;
static OpenSkyFetcher g_openSky;
static AeroAPIFetcher g_aeroApi;
static AdsbdbFetcher g_adsbdb;
static FlightDataFetcher *g_fetcher = nullptr;
static Hub75Display g_display;
static WebConfigServer g_web;
static SerialConsole g_console;
static LightSensor g_light;
static unsigned long g_lastLightMs = 0;

static const char *kMdnsHostname = "flightwall"; // reachable at http://flightwall.local
static bool g_apMode = false;
static unsigned long g_wifiDownSinceMs = 0; // for the runtime reconnect/AP-fallback watchdog
static unsigned long g_lastFetchMs = 0;
static unsigned long g_lastRenderMs = 0;
static bool g_firstFetchDone = false;
static int g_appliedBrightness = -1;
static std::vector<FlightInfo> g_lastFlights;

static const char *kSetupApSsid = "FlightWall-Setup";

// ---- Helpers --------------------------------------------------------------

static bool connectWifiSta()
{
    if (!g_settings.hasWifi())
        return false;

    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true); // recover transient drops without a reboot
    WiFi.persistent(false);
    g_display.displayMessage(String("WiFi: ") + g_settings.wifiSsid);
    WiFi.begin(g_settings.wifiSsid.c_str(), g_settings.wifiPassword.c_str());
    Serial.print("Connecting to WiFi");
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 150) // 150 * 200ms = 30s
    {
        delay(200);
        Serial.print(".");
        attempts++;
    }
    Serial.println();
    return WiFi.status() == WL_CONNECTED;
}

static void startSetupAp()
{
    g_apMode = true;
    WiFi.mode(WIFI_AP);
    WiFi.softAP(kSetupApSsid);
    IPAddress ip = WiFi.softAPIP();
    Serial.print("Setup AP started. Connect to '");
    Serial.print(kSetupApSsid);
    Serial.print("' then browse to http://");
    Serial.println(ip);
    g_display.displayMessage(String("Setup: ") + kSetupApSsid);
}

// Compute the local hour [0-23] using NTP UTC + the configured offset.
// Returns -1 if time is not yet synced.
static int localHourNow()
{
    time_t now = time(nullptr);
    if (now < 100000) // not synced yet
        return -1;
    long localSecs = (long)(now % 86400L) + (long)g_settings.schedule.timezoneOffsetMinutes * 60L;
    localSecs %= 86400L;
    if (localSecs < 0)
        localSecs += 86400L;
    return (int)(localSecs / 3600L);
}

static bool isNightHour(int hour)
{
    const auto &s = g_settings.schedule;
    if (s.nightStartHour == s.nightEndHour)
        return false;
    if (s.nightStartHour < s.nightEndHour)
        return hour >= s.nightStartHour && hour < s.nightEndHour;
    // Wrapping window, e.g. 22 -> 7
    return hour >= s.nightStartHour || hour < s.nightEndHour;
}

static void applyBrightness()
{
    uint8_t target = g_settings.brightness;
    if (g_settings.schedule.enabled)
    {
        int hour = localHourNow();
        if (hour >= 0)
            target = isNightHour(hour) ? g_settings.schedule.nightBrightness
                                       : g_settings.schedule.dayBrightness;
    }
    // Ambient light sensor overrides: blank or dim when the room is dark.
    if (g_settings.lightSensorEnabled && g_light.isDark())
        target = g_settings.lightSensorDimInstead ? g_settings.lightDimBrightness : 0;

    if ((int)target != g_appliedBrightness)
    {
        g_display.setBrightness(target);
        g_appliedBrightness = target;
    }
}

static String flightsToJson(const std::vector<FlightInfo> &flights)
{
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (const auto &f : flights)
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
    String out;
    serializeJson(doc, out);
    return out;
}

// [heapdiag] INTERNAL-RAM focused. On the S3, MALLOC_CAP_8BIT / getFreeHeap() include
// PSRAM and would hide internal starvation; INTERNAL is what TLS + DMA actually
// contend for. psramFree is 0 on the plain ESP32 (no PSRAM).
static void logHeap(const char *tag)
{
    Serial.printf("[heapdiag] %s: internalFree=%u largestInternal=%u largestDMA=%u psramFree=%u\n", tag,
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_DMA),
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

static void doFetchAndRender()
{
    logHeap("cycle-start");
    std::vector<StateVector> states;
    std::vector<FlightInfo> flights;
    size_t enriched = g_fetcher->fetchFlights(states, flights);

    Serial.print("Enriched flights: ");
    Serial.println((int)enriched);

    g_web.setFlightsJson(flightsToJson(flights));
    g_web.setLastFetchInfo((int)flights.size(),
                           g_settings.mode == TrackingMode::Flights ? "flights mode" : "area mode");

    g_lastFlights = std::move(flights);
    // A fetch always supplies fresh data: force a recompose even if the cycled
    // index is unchanged. The 200ms re-render path deliberately does NOT do this.
    g_display.markFlightsUpdated();
    g_display.displayFlights(g_lastFlights);
    g_lastRenderMs = millis();
    g_firstFetchDone = true;
}

// ---- Arduino entry points -------------------------------------------------
// Guarded so the Unity test runner (test_build_src=true) provides its own
// setup()/loop() without colliding with the firmware's.
#ifndef PIO_UNIT_TESTING

void setup()
{
    Serial.begin(115200);
    delay(200);

    g_settings.begin();
    g_console.begin();

    g_display.initialize();
    g_appliedBrightness = g_settings.brightness;
    g_light.begin();
    g_display.displayMessage(String("FlightWall"));

    bool connected = connectWifiSta();
    if (connected)
    {
        Serial.print("WiFi connected: ");
        Serial.println(WiFi.localIP());
        g_display.displayMessage(String("WiFi OK ") + WiFi.localIP().toString());
        delay(2000);
        // Advertise http://flightwall.local so the UI is reachable without the IP.
        if (MDNS.begin(kMdnsHostname))
        {
            MDNS.addService("http", "tcp", 80);
            Serial.printf("mDNS: http://%s.local\n", kMdnsHostname);
        }
        // NTP for brightness scheduling (UTC; offset applied locally).
        configTime(0, 0, "pool.ntp.org", "time.nist.gov");

        // Optionally seed the Area-mode center from IP geolocation.
        if (g_settings.autoLocateOnBoot)
        {
            GeoLocator geo;
            double lat = 0, lon = 0;
            String place;
            if (geo.locate(lat, lon, place))
            {
                g_settings.centerLat = lat;
                g_settings.centerLon = lon;
                g_settings.save();
                Serial.printf("Auto-located: %.4f, %.4f (%s)\n", lat, lon, place.c_str());
            }
        }

        g_display.showLoading();
    }
    else
    {
        startSetupAp();
    }

    g_web.setDisplay(&g_display);
    g_web.begin(g_apMode, g_apMode ? WiFi.softAPIP().toString() : WiFi.localIP().toString());

    g_adsbdb.setHttp(&g_http);
    g_aeroApi.setHttp(&g_http);
    g_fetcher = new FlightDataFetcher(&g_openSky, &g_aeroApi, &g_adsbdb);

    logHeap("boot-done");
}

void loop()
{
    g_console.poll();
    g_web.handle();

    if (g_web.consumeRestartRequested())
    {
        Serial.println("Restart requested via web UI");
        delay(200);
        ESP.restart();
    }

    if (g_web.consumeSettingsChanged())
    {
        // Re-apply runtime-tunable settings immediately. Hardware/WiFi changes
        // take effect on next reboot.
        g_light.begin();          // re-init for new sensor type/pin/enable
        g_appliedBrightness = -1; // force re-apply
        applyBrightness();
        g_display.markFlightsUpdated(); // recompose now so color/layout tweaks show
                                        // within 200ms, not only after the next fetch
        g_lastFetchMs = 0; // refresh promptly with new tracking/filter settings
    }

    // Sample the ambient light sensor a few times a second (cheap; works in all
    // modes so the panel auto-dims even on the setup AP).
    const unsigned long nowMs = millis();
    if (g_settings.lightSensorEnabled && nowMs - g_lastLightMs >= 500)
    {
        g_lastLightMs = nowMs;
        g_light.update();
        g_web.setLightStatus(g_light.level(), g_light.isDark());
    }
    applyBrightness();

    // Self-heal: in STA mode, if WiFi stays down for >60s (auto-reconnect failed,
    // e.g. the password changed), reboot. On restart it re-tries the network and
    // falls back to the FlightWall-Setup AP if it still can't connect.
    if (!g_apMode)
    {
        if (WiFi.status() == WL_CONNECTED)
        {
            g_wifiDownSinceMs = 0;
        }
        else
        {
            if (g_wifiDownSinceMs == 0)
                g_wifiDownSinceMs = nowMs;
            else if (nowMs - g_wifiDownSinceMs > 60000UL)
            {
                Serial.println("WiFi down >60s; restarting to re-provision");
                delay(100);
                ESP.restart();
            }
        }
    }

    // In AP setup mode we only serve the web UI (no network for fetching).
    if (g_apMode || WiFi.status() != WL_CONNECTED)
    {
        delay(5);
        return;
    }

    const unsigned long intervalMs = (unsigned long)g_settings.fetchIntervalSeconds * 1000UL;
    const unsigned long now = millis();
    if (!g_firstFetchDone || (now - g_lastFetchMs >= intervalMs))
    {
        g_lastFetchMs = now;
        doFetchAndRender();
    }
    else if (now - g_lastRenderMs >= 200)
    {
        // Re-render the cached flights so multi-flight cycling advances at
        // cycleSeconds between network fetches.
        g_lastRenderMs = now;
        g_display.displayFlights(g_lastFlights);
    }

    delay(10);
}

#endif // PIO_UNIT_TESTING
