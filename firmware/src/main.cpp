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
#include "esp_wifi.h"
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
#include "esp_task_wdt.h"
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
static uint8_t g_consecutiveFailures = 0;      // drives the fetch backoff
static unsigned long g_lastGoodFetchMs = 0;    // for the stale-data cutoff

static const char *kSetupApSsid = "FlightWall-Setup";

// ---- Helpers --------------------------------------------------------------

// Allow 2.4GHz channels 1-13 (US default is 1-11) so the device can see and join
// a router whose auto-channel landed on 12/13. MANUAL policy honors nchan=13.
static void applyWifiRegion()
{
    wifi_country_t ctry = {};
    ctry.cc[0] = 'U';
    ctry.cc[1] = 'S';
    ctry.cc[2] = '\0';
    ctry.schan = 1;
    ctry.nchan = 13;
    ctry.policy = WIFI_COUNTRY_POLICY_MANUAL;
    esp_wifi_set_country(&ctry);
}

static bool connectWifiSta()
{
    if (!g_settings.hasWifi())
        return false;

    WiFi.mode(WIFI_STA);
    applyWifiRegion();           // unlock ch 12-13 before associating
    WiFi.setAutoReconnect(true); // recover transient drops without a reboot
    WiFi.persistent(false);
    // Modem sleep OFF. arduino-esp32 defaults _sleepEnabled to WIFI_PS_MIN_MODEM on
    // every target except the S2 (WiFiGeneric.cpp: the #if CONFIG_IDF_TARGET_ESP32S2
    // branch is the ONLY one that gets WIFI_PS_NONE), so the S3 sleeps between DTIM
    // beacons unless told otherwise. That parks the radio mid-TLS-handshake and is a
    // prime suspect for the outbound connect timeouts and mid-handshake resets we
    // see while inbound LAN requests are unaffected. This is mains-powered on a wall;
    // the ~20-30mA it costs buys nothing here.
    WiFi.setSleep(false);
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
    applyWifiRegion(); // keep region consistent (AP defaults to a 1-11 channel anyway)
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
    bool ok = false;
    size_t enriched = g_fetcher->fetchFlights(states, flights, ok);
    if (!ok)
    {
        if (g_consecutiveFailures < 255)
            g_consecutiveFailures++;
        Serial.printf("Fetch FAILED (%u consecutive) — keeping last flights\n", (unsigned)g_consecutiveFailures);
        g_web.setLastFetchInfo((int)g_lastFlights.size(), "fetch failed - showing last known");
        // Keep showing the last good list rather than blanking the wall, but don't
        // show hours-old data forever: clear it once it's clearly stale.
        const unsigned long staleMs = (unsigned long)g_settings.fetchIntervalSeconds * 1000UL * 6UL;
        if (g_lastGoodFetchMs != 0 && (millis() - g_lastGoodFetchMs) > staleMs && !g_lastFlights.empty())
        {
            Serial.println("Last flights are stale; clearing");
            g_lastFlights.clear();
            g_display.markFlightsUpdated();
            g_display.displayFlights(g_lastFlights);
        }
        g_firstFetchDone = true; // so the loop keeps its cadence/backoff rather than hot-looping
        g_lastRenderMs = millis();
        return;
    }
    g_consecutiveFailures = 0;
    g_lastGoodFetchMs = millis();

    Serial.print("Enriched flights: ");
    Serial.println((int)enriched);

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

    // [boot] Confirm PSRAM initialized: 0/false on the plain ESP32; ~8MB on the S3
    // N16R8. A 0 here on the S3 means memory_type is wrong -> the TLS-in-PSRAM fix
    // won't apply (and the chip may boot-loop). This is the migration's go/no-go check.
    Serial.printf("[boot] PSRAM: size=%u found=%d\n", (unsigned)ESP.getPsramSize(), (int)psramFound());

    g_settings.begin();
    g_console.begin();

    g_display.initialize();
    g_appliedBrightness = g_settings.brightness;
    g_light.begin();
    g_display.displaySplash();
    delay(1500); // hold the branded splash briefly before WiFi status takes over

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

    // Point the web server at the long-lived global flights vector. Its address
    // is fixed (global), so it stays valid across the std::move in doFetchAndRender.
    // /api/flights serializes from this on demand instead of every fetch cycle.
    g_web.setFlights(&g_lastFlights);
    g_web.begin(g_apMode, g_apMode ? WiFi.softAPIP().toString() : WiFi.localIP().toString());

    g_adsbdb.setHttp(&g_http);
    g_aeroApi.setHttp(&g_http);
    g_fetcher = new FlightDataFetcher(&g_openSky, &g_aeroApi, &g_adsbdb);

    // Liveness backstop. loopTask runs on core 1, whose idle task arduino does NOT
    // watch, and loopTask isn't auto-subscribed — so today a hung loop() is silent.
    // The timeout is deliberately generous: a healthy fetch can legitimately block
    // for seconds, and CONFIG_ESP_TASK_WDT_PANIC=y means a trip REBOOTS. 120s only
    // fires on a genuine hang, never on a slow-but-progressing cycle.
    // Only subscribe if the timeout actually took. If the reconfigure fails we would
    // otherwise be subscribing loopTask to the 5s DEFAULT, and a healthy multi-second
    // fetch would reboot-loop the device — worse than the silent hang we're fixing.
    esp_err_t wdtErr = esp_task_wdt_init(120, true); // reconfigures; TWDT is auto-inited
    if (wdtErr == ESP_OK)
    {
        enableLoopWDT();
    }
    else
    {
        Serial.printf("[wdt] timeout reconfigure failed (%d); leaving loop WDT off\n", (int)wdtErr);
    }

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
        g_display.applySettings();      // resize the logo pool if maxFlights changed
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

    unsigned long intervalMs = (unsigned long)g_settings.fetchIntervalSeconds * 1000UL;
    if (g_consecutiveFailures > 0)
    {
        // Exponential backoff on consecutive failures: 2x per failure, capped at 5 min.
        // Protects the OpenSky daily credit budget when the API or WiFi is down.
        uint8_t shift = g_consecutiveFailures > 4 ? 4 : g_consecutiveFailures;
        unsigned long backoff = intervalMs << shift;
        const unsigned long kMaxBackoffMs = 300000UL;
        intervalMs = backoff > kMaxBackoffMs ? kMaxBackoffMs : backoff;
    }
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
