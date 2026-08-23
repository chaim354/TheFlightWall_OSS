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
#include "esp_netif.h"
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
#include "adapters/FlightRadar24Fetcher.h"
#include "adapters/AdsbLolFetcher.h"
#include "adapters/AeroAPIFetcher.h"
#include "adapters/AdsbdbFetcher.h"
#include "adapters/FlightWallServerFetcher.h"
#include "core/FlightDataFetcher.h"
#include "core/WebConfigServer.h"
#include "core/SerialConsole.h"
#include "adapters/Hub75Display.h"
#include "adapters/LightSensor.h"
#include "adapters/Buttons.h"
#include "utils/BrightnessLadder.h"
#include "adapters/GeoLocator.h"

static HttpJson g_http;
static OpenSkyFetcher g_openSky;
static FlightRadar24Fetcher g_fr24;
// Keyless fallback source -- also what the server path itself falls back to
// when the FlightWall server is unreachable (see FlightDataFetcher).
static AdsbLolFetcher g_adsbLol;
static AeroAPIFetcher g_aeroApi;
static AdsbdbFetcher g_adsbdb;
// One HTTP call, display-ready flights -- skips Area-mode enrichment entirely
// when g_settings.positionSource == PositionSource::FlightWallServer.
static FlightWallServerFetcher g_server;
static FlightDataFetcher *g_fetcher = nullptr;
static Hub75Display g_display;
static WebConfigServer g_web;
static SerialConsole g_console;
static LightSensor g_light;
static Buttons g_buttons;
// Button state. g_manualBrightness == -1 means "no override".
static int g_manualBrightness = -1;
static bool g_panelOff = false;
static uint32_t g_lastAutoStateKey = 0;
static unsigned long g_settingsDirtyMs = 0;
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
static uint8_t g_consecutiveEmpty = 0;         // successful fetches that returned nothing

// How many consecutive empty-but-successful fetches to see before believing the sky
// really is empty. A rate-limited Flightradar24 reply is HTTP 200 carrying valid JSON
// with the scalar keys and no flight rows, so it is indistinguishable from an empty
// bounding box by content — full_count is FR24's GLOBAL tracked count, not ours. At 2
// the cost is one extra cycle of stale data over a genuinely quiet sky; at 1 (i.e.
// disabled) a throttled source flips the wall between flights and noFlightsMode every
// cycle. Deliberately NOT routed through g_consecutiveFailures: that would back the
// poll interval out to 5 minutes over a quiet sky and delay the first real arrival.
static const uint8_t kEmptyConfirmCycles = 2;

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

/** Defined below; called once the STA lease is up. */
static void useReliableDns();

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
    if (WiFi.status() == WL_CONNECTED)
        useReliableDns();
    return WiFi.status() == WL_CONNECTED;
}

/**
 * Point the resolver at public DNS instead of whatever DHCP handed out.
 *
 * MEASURED, not precautionary. With CORE_DEBUG_LEVEL raised to INFO, the
 * failing fetch cycles turned out to be neither TLS nor TCP:
 *
 *   [E][WiFiGeneric.cpp:1583] hostByName(): DNS Failed for api.adsb.lol
 *   [E][WiFiGeneric.cpp:1583] hostByName(): DNS Failed for flightwall.tinkerex.com
 *
 * Both fetchers failing together, on a link with -60dBm signal, 159KB of
 * contiguous internal heap and a LAN that answered pings in 12ms, because
 * neither could resolve a name. Nothing downstream of that -- handshake
 * timeouts, buffer sizes, fallback ordering -- was ever the problem.
 *
 * lwIP's resolver is a poor fit for a flaky upstream: a small cache, a short
 * timeout and few retries, so a merely SLOW answer from the router is
 * indistinguishable from no answer. Querying a public resolver directly takes
 * the router's forwarder out of the path entirely.
 *
 * DHCP is left doing everything else. Only the two DNS entries are replaced,
 * by writing them into the STA netif after the lease is up -- WiFi.config()
 * would pin the address, gateway and netmask too, which is a much bigger
 * behavioural change than this needs and would break on any network that
 * hands out something other than what was hardcoded.
 *
 * Failure here is deliberately non-fatal: if the netif is not ready or the
 * call is rejected, the DHCP-supplied servers stay in place and the device
 * behaves exactly as it did before.
 */
static void useReliableDns()
{
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (!netif)
    {
        Serial.println("DNS: no STA netif; keeping DHCP resolvers");
        return;
    }

    // Cloudflare primary, Google secondary -- two independent operators, so a
    // single provider's outage does not take name resolution with it.
    const uint32_t servers[2] = {
        0x01010101u, // 1.1.1.1
        0x08080808u, // 8.8.8.8
    };
    const esp_netif_dns_type_t types[2] = {ESP_NETIF_DNS_MAIN, ESP_NETIF_DNS_BACKUP};

    for (int i = 0; i < 2; i++)
    {
        esp_netif_dns_info_t dns = {};
        dns.ip.type = ESP_IPADDR_TYPE_V4;
        // esp_ip4_addr_t stores the address in network byte order; the literals
        // above are written big-endian-as-read, so convert rather than assign.
        dns.ip.u_addr.ip4.addr = htonl(servers[i]);
        esp_err_t err = esp_netif_set_dns_info(netif, types[i], &dns);
        if (err != ESP_OK)
            Serial.printf("DNS: could not set resolver %d (%s); keeping DHCP\n", i, esp_err_to_name(err));
    }
    Serial.println("DNS: using 1.1.1.1 / 8.8.8.8");
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
    struct tm tmv;
    localtime_r(&now, &tmv); // TZ-aware, DST included — see configTzTime in setup()
    return tmv.tm_hour;
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

// A key describing the AUTOMATIC sources' current state. A manual (button) override
// lasts until this changes — i.e. until the wall would have changed brightness on its
// own: a schedule day/night boundary, or the light sensor flipping dark<->lit.
//
// Why not "manual wins until reboot": the panel would silently stop auto-dimming at
// night and you would never connect that to a button you pressed last week. Why not
// "auto always wins": then the button visibly does nothing whenever the schedule or
// sensor is active, which reads as broken hardware. Expiring at the next transition
// makes the override real but self-healing — the same bargain a thermostat's
// temporary hold makes.
static uint32_t autoStateKey()
{
    uint32_t k = 1;
    if (g_settings.schedule.enabled)
    {
        const int hour = localHourNow();
        k = k * 3 + (hour < 0 ? 0u : (isNightHour(hour) ? 1u : 2u));
    }
    if (g_settings.lightSensorEnabled)
        k = k * 3 + (g_light.isDark() ? 1u : 2u);
    return k;
}

static void applyBrightness()
{
    const uint32_t key = autoStateKey();
    if (key != g_lastAutoStateKey)
    {
        g_lastAutoStateKey = key;
        g_manualBrightness = -1; // an automatic transition retires the override
    }

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

    // A button ramp outranks both automatic sources, until the next transition above.
    if (g_manualBrightness >= 0)
        target = (uint8_t)g_manualBrightness;
    // The off toggle outranks everything, including a manual brightness.
    if (g_panelOff)
        target = 0;

    if ((int)target != g_appliedBrightness)
    {
        g_display.setBrightness(target);
        g_appliedBrightness = target;
    }
}

// Mark settings for a deferred save. A brightness ramp changes g_settings.brightness
// on every rung, and Settings::save() atomically rewrites the WHOLE file (tmp+rename)
// — so saving per step would mean ~15 full flash rewrites per hold. Coalesce instead.
static void markSettingsDirty()
{
    g_settingsDirtyMs = millis();
}

static void setManualBrightness(uint8_t v)
{
    g_manualBrightness = v;
    g_settings.brightness = v; // persist the base so a ramp survives a reboot
    g_panelOff = false;        // reaching for brightness means you want it visible
    markSettingsDirty();
    g_appliedBrightness = -1;
    applyBrightness();
}

static void handleButtons()
{
    if (!g_settings.buttonsEnabled)
        return;

    const ButtonEvents e = g_buttons.poll(millis());
    if (!(e.clickA || e.rampA || e.clickB || e.rampB))
        return;

    // Ramp from what is actually ON the panel, not from the stored base: if the
    // schedule or the sensor has dimmed it, "up" should step from what you can see.
    const uint8_t cur = g_appliedBrightness >= 0 ? (uint8_t)g_appliedBrightness
                                                 : g_settings.brightness;
    if (e.rampA)
        setManualBrightness(brightnessUp(cur));
    if (e.rampB)
        setManualBrightness(brightnessDown(cur));

    if (e.clickA)
    {
        // Deliberately NOT persisted: a panel that boots dark because of a button
        // pressed last week is indistinguishable from a dead board.
        g_panelOff = !g_panelOff;
        g_appliedBrightness = -1;
        applyBrightness();
    }

    if (e.clickB)
    {
        static const char *kModes[] = {"dots", "clock", "funfact", "clockfact"};
        size_t i = 0;
        while (i < 4 && g_settings.layout.noFlightsMode != kModes[i])
            ++i;
        if (i >= 4)
            i = 0; // unknown value -> land on a known one rather than guessing
        g_settings.layout.noFlightsMode = kModes[(i + 1) % 4];
        markSettingsDirty();
        g_display.markFlightsUpdated();
        g_display.showToast(g_settings.layout.noFlightsMode);
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
        // Deliberately NOT g_web.setServerStale(g_fetcher->lastFetchStale()) here:
        // a failed cycle's own stale flag is meaningless (fetchServerMode() only
        // sets it true on a SUCCESSFUL server response), and overwriting it would
        // desync the pill from _lastFlightCount/_lastNote just above, which both
        // deliberately keep describing the RETAINED g_lastFlights rather than this
        // cycle's failed attempt. Leaving _serverStale untouched keeps it doing
        // the same thing: still describing whichever cycle's data is on screen.
        const unsigned long staleMs = (unsigned long)g_settings.fetchIntervalSeconds * 1000UL * 6UL;
        if (g_lastGoodFetchMs != 0 && (millis() - g_lastGoodFetchMs) > staleMs && !g_lastFlights.empty())
        {
            Serial.println("Last flights are stale; clearing");
            g_lastFlights.clear();
            g_display.markFlightsUpdated();
            g_display.displayFlights(g_lastFlights);
            g_web.setServerStale(false); // nothing left on screen to BE stale
        }
        g_firstFetchDone = true; // so the loop keeps its cadence/backoff rather than hot-looping
        g_lastRenderMs = millis();
        return;
    }
    // Only a fetch that actually produced flights clears the failure backoff. An empty
    // result is not evidence the source is healthy — under Flightradar24 a rate-limited
    // reply IS this shape (HTTP 200, valid JSON, no rows). Measured over 16 minutes on
    // hardware: the backoff had correctly grown to 245s between attempts, then an empty
    // result reset it and the next gap was 71s; that happened twice in one window. The
    // one mechanism relieving pressure was being discarded by the very responses that
    // signal it. A genuinely quiet sky is unaffected: nothing increments the counter
    // unless fetches are actually failing.
    if (!flights.empty())
        g_consecutiveFailures = 0;
    g_lastGoodFetchMs = millis();

    Serial.print("Enriched flights: ");
    Serial.println((int)enriched);

    // Hold the previous list through the first empty result rather than blanking on it.
    // The !ok path above already protects a FAILED fetch this way; an empty SUCCESSFUL
    // fetch had no such grace, so a throttled source blanked the wall instantly.
    if (flights.empty())
    {
        if (g_consecutiveEmpty < 255)
            g_consecutiveEmpty++;
        if (g_consecutiveEmpty < kEmptyConfirmCycles && !g_lastFlights.empty())
        {
            Serial.printf("Empty result (%u of %u) — holding last flights\n",
                          (unsigned)g_consecutiveEmpty, (unsigned)kEmptyConfirmCycles);
            g_web.setLastFetchInfo((int)g_lastFlights.size(), "empty result - holding last known");
            // Same reasoning as the !ok path above: g_lastFlights (and whatever
            // staleness applied to it) is unchanged this cycle, so _serverStale
            // is left alone rather than overwritten with this cycle's own value.
            g_lastRenderMs = millis();
            g_firstFetchDone = true;
            return;
        }
    }
    else
    {
        g_consecutiveEmpty = 0;
    }

    g_web.setLastFetchInfo((int)flights.size(),
                           g_settings.mode == TrackingMode::Flights ? "flights mode" : "area mode");
    // Only reached when g_lastFlights is about to actually be REPLACED below --
    // the one point in this function where "this cycle's result" and "what's
    // now on screen" are the same thing, matching the precedent set by
    // setLastFetchInfo just above.
    g_web.setServerStale(g_fetcher->lastFetchStale());

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
    g_console.setLightSensor(&g_light); // `light` command reads it live over serial

    g_display.initialize();
    g_appliedBrightness = g_settings.brightness;
    g_light.begin();
    g_buttons.begin();
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
        // configTzTime (not configTime) so libc owns the zone: it setenv()s TZ and
        // tzset()s, after which localtime_r handles DST transitions itself. The old
        // fixed offset had no DST information at all.
        configTzTime(g_settings.schedule.timezone.c_str(), "pool.ntp.org", "time.nist.gov");

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
    g_fetcher = new FlightDataFetcher(&g_openSky, &g_fr24, &g_aeroApi, &g_adsbdb, &g_adsbLol, &g_server);

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
    handleButtons();

    // Flush button-driven settings ~10s after the last change. See markSettingsDirty:
    // a ramp touches g_settings.brightness on every rung and save() rewrites the whole
    // file, so this coalesces a hold into one write instead of ~15.
    if (g_settingsDirtyMs != 0 && millis() - g_settingsDirtyMs >= 10000)
    {
        g_settingsDirtyMs = 0;
        g_settings.save();
    }
    g_web.handle();

    if (g_web.consumeRestartRequested())
    {
        Serial.println("Restart requested via web UI");
        delay(200);
        ESP.restart();
    }

    // Bitwise |, NOT ||. Both flags are one-shot and must BOTH be drained every
    // pass: short-circuiting would leave the console's set while the web's was
    // true, so a console change made in the same pass as a web change would be
    // silently swallowed until the next unrelated web save.
    if (g_web.consumeSettingsChanged() | g_console.consumeSettingsChanged())
    {
        // Re-apply runtime-tunable settings immediately. Hardware/WiFi changes
        // take effect on next reboot.
        // Re-apply the zone: TZ lives in libc's environment, not in Settings, so a
        // change here is invisible to localtime_r until tzset() runs again.
        setenv("TZ", g_settings.schedule.timezone.c_str(), 1);
        tzset();
        g_light.begin();          // re-init for new sensor type/pin/enable
        g_buttons.begin();        // re-init for the new enable flag
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
    else if (g_consecutiveEmpty >= kEmptyConfirmCycles)
    {
        // Sustained empties get their own, gentler ladder. This covers the case the
        // branch above cannot see: a source that is rate-limiting us purely with
        // well-formed empty replies never sets ok=false, so g_consecutiveFailures stays
        // 0 and we would otherwise keep polling at the base rate indefinitely — which is
        // precisely the behaviour that sustains a rate limit.
        //
        // Capped at 2 minutes rather than the 5 above, because unlike a failure an empty
        // result may simply be a quiet sky, and a 5-minute hole there would delay the
        // first real arrival for no reason. Self-correcting either way: fewer requests
        // let the limit lapse, flights come back, the counter resets, and the interval
        // returns to whatever the user configured without anyone touching a setting.
        // Engages on the SECOND consecutive empty, not the third. FR24's limiting
        // alternates rather than clustering: measured over 13 minutes at a 50% throttle
        // rate, the longest run of consecutive empties was two, so a ladder that waited
        // for three stayed dormant through the entire window it was written for. Biasing
        // the shift by one means the pair that actually occurs is enough to slow us down.
        // The cost is that two quiet cycles over a genuinely empty sky now stretch the
        // interval too — bounded by the 2-minute cap below, and cleared by the first
        // cycle that returns any flight.
        const uint8_t extra = (uint8_t)(g_consecutiveEmpty - kEmptyConfirmCycles + 1);
        const uint8_t shift = extra > 2 ? 2 : extra;
        unsigned long backoff = intervalMs << shift;
        const unsigned long kMaxEmptyBackoffMs = 120000UL;
        intervalMs = backoff > kMaxEmptyBackoffMs ? kMaxEmptyBackoffMs : backoff;
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
