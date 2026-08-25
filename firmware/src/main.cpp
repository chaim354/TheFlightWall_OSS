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
#include "core/AssetUpdater.h"
#include "core/FirmwareUpdater.h"
#include "core/ControlClient.h"
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
#include "utils/FetchCadence.h"
#include "utils/IdleWhenDark.h"
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
// When the setup AP started, for the bounded-retry watchdog below. Zero means
// "not counting" -- either we are not in AP mode, or there are no credentials to
// retry with and the AP must stay up indefinitely.
static unsigned long g_apSinceMs = 0;
// When the setup AP came up, and whether its panel DMA has been stopped yet.
// Separate from g_apSinceMs above, which is the bounded-retry watchdog and gets
// zeroed the moment there are no credentials -- exactly the case this runs in.
static unsigned long g_apStartedMs = 0;
static bool g_apDmaStopped = false;
// Set when a remote command changed settings; consumed by the same block that
// handles a LAN save, so remote and local edits cannot diverge in behaviour.
static bool g_controlSettingsChanged = false;
// How long the CURRENT lit period lasts. Starts at the 30s opener and becomes a
// full minute for every later one; see the duty-cycle block in loop().
static unsigned long g_apPanelLitMs = 0;
// Last countdown redraw, so the lit panel ticks once a second.
static unsigned long g_apCountdownMs = 0;
// How long the panel keeps showing the setup instructions before its DMA is
// halted.
//
// The panel is the only place the AP name is written down, so it has to be
// readable first -- but the HUB75 DMA is also the prime suspect for why clients
// cannot associate. This project has already caught that DMA starving the radio
// once (commit 4218dc0, where it was corrupting TLS in station mode), and the
// setup AP is worse off than station mode: it has to beacon and answer auth
// frames on a schedule it does not control. Measured from a laptop beside the
// wall, the AP appeared in roughly one scan in three -- a healthy AP is in all
// of them.
//
// 30s: long enough to read a short SSID and an IP off the wall, short enough
// that nobody is standing there waiting.
static const unsigned long kApDmaOffAfterMs = 30UL * 1000UL;
// ...then the panel comes BACK for a minute out of every six, so the wall is
// never permanently blank while someone is trying to set it up. A dark panel
// with no explanation is indistinguishable from a dead one, which is why the
// screen says what it is doing rather than just going out.
//
// Five minutes dark is the part that matters: that is when the radio has the
// bus to itself and a client can actually associate. The minute of light is
// for a person who walked up late and needs the network name again -- it will
// make joining hard for that minute, and the on-screen note says so.
static const unsigned long kApPanelDarkMs = 5UL * 60UL * 1000UL;
static const unsigned long kApPanelLitMs = 60UL * 1000UL;

// How long the setup AP may hold a device that HAS credentials before rebooting
// to retry STA. Long enough to finish provisioning by hand, short enough that a
// router that came up late does not strand the panel for the evening.
static const unsigned long kApRetryAfterMs = 10UL * 60UL * 1000UL;
static unsigned long g_lastFetchMs = 0;
static unsigned long g_lastRenderMs = 0;
static bool g_firstFetchDone = false;
static int g_appliedBrightness = -1;
static std::vector<FlightInfo> g_lastFlights;
static uint8_t g_consecutiveFailures = 0;      // drives the fetch backoff
static unsigned long g_lastGoodFetchMs = 0;    // for the stale-data cutoff
// Whether the previous loop pass suppressed fetching because the panel was dark.
// Only used to detect the WAKE edge; see utils/IdleWhenDark.h.
static bool g_fetchSuppressed = false;
static uint8_t g_consecutiveEmpty = 0;         // successful fetches that returned nothing

// How many consecutive empty-but-successful fetches to see before believing the sky
// really is empty. A rate-limited Flightradar24 reply is HTTP 200 carrying valid JSON
// with the scalar keys and no flight rows, so it is indistinguishable from an empty
// bounding box by content — full_count is FR24's GLOBAL tracked count, not ours. At 2
// the cost is one extra cycle of stale data over a genuinely quiet sky; at 1 (i.e.
// disabled) a throttled source flips the wall between flights and noFlightsMode every
// cycle. Deliberately NOT routed through g_consecutiveFailures: that would back the
// poll interval out to 5 minutes over a quiet sky and delay the first real arrival.

static const char *kSetupApSsid = "FlightWall-Setup";

// What the wall says while it is waiting to be set up. Kept to <=21 columns a
// line (128px / 6px per char) so nothing is truncated.
static String setupScreenText(unsigned long secsToDark)
{
    String out = String("Join wifi:\n") + kSetupApSsid + "\nhttp://192.168.4.1\n";
    // A countdown rather than a static "sleeps in a bit": the panel going black
    // is the single most alarming thing this device does, and someone standing
    // in front of it needs to know it is about to happen, not be told
    // afterwards that it was deliberate.
    out += (secsToDark > 0) ? ("dark in " + String(secsToDark) + "s") : String("going dark now");
    out += "\n(dark = wifi works)";
    return out;
}


// ---- Helpers --------------------------------------------------------------

// 2.4GHz regulatory domain. The channel COUNT differs by role, and that
// difference is the whole reason this takes a parameter.
//
// As a STATION, 13: the device must be able to see and join a router whose
// auto-channel landed on 12 or 13. Nothing is transmitted there unprompted --
// the router is the one beaconing -- and US routers do occasionally land there.
//
// As an ACCESS POINT, 11. Under POLICY_MANUAL this country info goes into our
// OWN beacons, and "US" advertising 13 channels is not a valid US regulatory
// domain: the US permits 1-11. A client that enforces country IEs (Apple's do,
// strictly) can refuse or badly delay association to an AP whose beacon
// contradicts itself -- and the device cannot see that happening. From here the
// AP is up, healthy, serving, and simply nobody arrives; both an iPhone and a
// laptop took minutes or timed out against the 13-channel beacon.
//
// The AP channel itself was never the problem, which is what the previous
// comment here reasoned about ("AP defaults to a 1-11 channel anyway") -- true,
// and beside the point, because what the beacon ADVERTISES is the country IE.
static const uint8_t kStaChannels = 13; // join a router on 12/13
static const uint8_t kApChannels = 11;  // beacon a domain the US actually has

static void applyWifiRegion(uint8_t nchan)
{
    wifi_country_t ctry = {};
    ctry.cc[0] = 'U';
    ctry.cc[1] = 'S';
    ctry.cc[2] = '\0';
    ctry.schan = 1;
    ctry.nchan = nchan;
    ctry.policy = WIFI_COUNTRY_POLICY_MANUAL;
    esp_wifi_set_country(&ctry);
}

/** Defined below; called once the STA lease is up. */
static void useReliableDns();
/** Defined below; pulls any logo tile this cycle's flights need. */
static void fetchMissingLogos();
/** Defined below; reports to the server and applies anything queued there. */
static void controlCheckIn();

static bool connectWifiSta()
{
    if (!g_settings.hasWifi())
        return false;

    WiFi.mode(WIFI_STA);
    applyWifiRegion(kStaChannels); // unlock ch 12-13 before associating
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
    applyWifiRegion(kApChannels); // a valid US domain in our own beacon -- see above
    WiFi.softAP(kSetupApSsid);
    // HT20, not HT40. MEASURED: with the default the AP beacons "Channel 1
    // (2GHz, 40MHz)" -- a 40MHz channel on 2.4GHz spans roughly channels 1-5,
    // and this band is not empty (neighbours on 1, 6, 7 and 11). Clients saw
    // the network and then timed out associating: an iPhone took minutes, a
    // laptop gave up entirely, while the device reported a perfectly healthy AP
    // the whole time, because from its side nothing had failed -- nobody had
    // arrived. 40MHz on 2.4GHz buys throughput this AP has no use for; it
    // serves a 1KB form.
    //
    // Set AFTER softAP(): the interface has to exist before its bandwidth can
    // be configured.
    esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW_HT20);
    IPAddress ip = WiFi.softAPIP();
    Serial.print("Setup AP started. Connect to '");
    Serial.print(kSetupApSsid);
    Serial.print("' then browse to http://");
    Serial.println(ip);
    g_display.displayMessage(setupScreenText(kApDmaOffAfterMs / 1000));
    g_apStartedMs = millis();
    g_apDmaStopped = false;
    g_apPanelLitMs = kApDmaOffAfterMs; // the 30s opener; later lit periods are a minute
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
        // Guarded by the enable flag, exactly as applyBrightness() guards its use of
    // the same reading. Unguarded, a switched-off sensor could still flip this
    // key and retire the user's manual brightness override -- a button ramp
    // undone by a sensor nobody is listening to, with nothing on screen or in
    // the API to account for it.
    k = k * 3 + ((g_settings.lightSensorEnabled && g_light.isDark()) ? 1u : 2u);
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
    g_settings.markDirty();
}

// Settle any pending button-driven write NOW. Called on the debounce and before
// every reboot: both restart paths used to drop it, so pressing the mode button
// and hitting Restart within ten seconds reverted the change. (A watchdog panic
// still drops it -- that is inherent to deferring, and out of scope.)
static void flushSettingsIfDirty()
{
    if (!g_settings.dirty())
        return;
    g_settingsDirtyMs = 0;
    g_settings.save();
}

// 6x the configured interval: the single definition of "too old to show".
static unsigned long staleWindowMs()
{
    return (unsigned long)g_settings.fetchIntervalSeconds * 1000UL * 6UL;
}

// Drop what's on screen. NOTE this lands on the NO-FLIGHTS card (displayFlights
// with an empty vector takes Hub75Display's SIZE_MAX branch to displayNoFlights:
// dots, clock, fun fact), not the loading card -- so for as long as it is up it
// asserts "the sky is empty" rather than "we don't know yet". Tolerable on both
// callers because neither leaves it up long: the failure path only reaches here
// after a >3-minute streak, and the wake path forces a fetch on the same pass.
static void clearStaleFlights(const char *why)
{
    Serial.println(why);
    g_lastFlights.clear();
    g_display.markFlightsUpdated();
    g_display.displayFlights(g_lastFlights);
    g_web.setServerStale(false); // nothing left on screen to BE stale
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
    std::vector<FlightInfo> flights;
    bool ok = false;
    size_t enriched = g_fetcher->fetchFlights(flights, ok);
    if (!ok)
    {
        if (g_consecutiveFailures < 255)
            g_consecutiveFailures++;
        Serial.printf("Fetch FAILED (%u consecutive) — keeping last flights\n", (unsigned)g_consecutiveFailures);
        g_web.setLastNote("fetch failed - showing last known");
        // Deliberately NOT g_web.setServerStale(g_fetcher->lastFetchStale()) here:
        // a failed cycle's own stale flag is meaningless (fetchServerMode() only
        // sets it true on a SUCCESSFUL server response), and overwriting it would
        // desync the pill from _lastNote just above, which deliberately keeps
        // describing the RETAINED g_lastFlights rather than this cycle's failed
        // attempt. Leaving _serverStale untouched keeps it doing
        // the same thing: still describing whichever cycle's data is on screen.
        if (g_lastGoodFetchMs != 0 && (millis() - g_lastGoodFetchMs) > staleWindowMs() && !g_lastFlights.empty())
            clearStaleFlights("Last flights are stale; clearing");
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
            g_web.setLastNote("empty result - holding last known");
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

    // A FETCH OUTCOME, not an echo of `mode`. /api/status already emits `mode`
    // live from g_settings one line above this in the payload, so echoing it
    // here made the document contradict itself for a whole fetch interval after
    // a mode switch -- and cost the field its only real use, which is saying
    // what the last fetch actually did.
    g_web.setLastNote("fetch ok");
    // Only reached when g_lastFlights is about to actually be REPLACED below --
    // the one point in this function where "this cycle's result" and "what's
    // now on screen" are the same thing, matching the precedent set by
    // setLastFetchInfo just above.
    g_web.setServerStale(g_fetcher->lastFetchStale());

    g_lastFlights = std::move(flights);

    // The device has now proved it can do its job: WiFi associated, the server
    // answered, flights are in hand. THAT is what cancels the bootloader's
    // pending rollback -- not merely having reached setup().
    //
    // The distinction is the whole value of rollback. An image that starts,
    // brings up the panel and then cannot reach the network is exactly the
    // failure a cable-free update most needs protecting against, and it would
    // sail through a "we booted" check. Left unmarked, the bootloader reverts
    // to the previous image on the next restart, with no cable involved.
    //
    // A no-op on a cable-flashed build, which is not pending anything.
    FirmwareUpdater::markRunningImageValid();

    fetchMissingLogos();
    controlCheckIn();
    // A fetch always supplies fresh data: force a recompose even if the cycled
    // index is unchanged. The 200ms re-render path deliberately does NOT do this.
    g_display.markFlightsUpdated();
    g_display.displayFlights(g_lastFlights);
    g_lastRenderMs = millis();
    g_firstFetchDone = true;
}

// Pull any logo tile this cycle's flights need and the device does not have.
//
// HERE rather than inside tileFor(): that runs on the render path, and a card
// must never wait on a network call to draw. By the time this runs the fetch is
// already done, the flights are in hand, and blocking briefly costs nothing
// that is on screen.
//
// Bounded per cycle. A wall that has just been flashed sees a dozen unfamiliar
// operators at once, and fetching all of them back to back would stall the loop
// through the whole carousel -- on a radio this panel already degrades. Two per
// cycle catches up within a few minutes and is invisible while it does.
static void fetchMissingLogos()
{
    if (g_settings.serverUrl.length() == 0)
        return; // nothing to fetch from; the built-in tiles are all there is

    const int kMaxPerCycle = 2;
    int fetched = 0;
    for (const FlightInfo &f : g_lastFlights)
    {
        if (fetched >= kMaxPerCycle)
            break;
        if (f.operator_icao.length() == 0)
            continue;
        const AssetUpdater::LogoResult r =
            AssetUpdater::ensureLogo(g_settings.serverUrl, f.operator_icao);
        if (r == AssetUpdater::LogoResult::Downloaded)
        {
            // Replace the cached MISS, or the operator stays logo-less until
            // that entry happens to be evicted -- which on a quiet carousel
            // could be a very long time.
            g_display.reloadTile(f.operator_icao);
            fetched++;
        }
        else if (r == AssetUpdater::LogoResult::Failed)
        {
            fetched++; // a failure still costs a request; do not retry in a tight loop
        }
    }
}

// Report to the server and apply anything queued there.
//
// On the fetch cycle rather than a timer of its own: the device is already
// talking to this server every cycle, so this adds one request to a
// conversation that exists instead of inventing a second cadence. It also means
// remote control has exactly the latency the wall already runs at -- a change
// lands within one fetch interval, which is the honest cost of never opening an
// inbound port.
//
// Silent when unconfigured: no token, no request.
static void controlCheckIn()
{
    if (g_settings.controlToken.length() == 0 || g_settings.serverUrl.length() == 0)
        return;

    // What the wall reports about itself. Deliberately the same values
    // /api/status serves, so the remote page and the LAN page describe the
    // device identically rather than approximately.
    JsonDocument doc;
    doc["fwVersion"] = FirmwareUpdater::runningVersion();
    doc["ip"] = WiFi.localIP().toString();
    doc["rssi"] = WiFi.RSSI();
    doc["flightCount"] = (int)g_lastFlights.size();
    doc["note"] = g_web.lastNote();
    doc["brightness"] = g_appliedBrightness;
    doc["panelOff"] = g_panelOff;
    doc["mode"] = (g_settings.mode == TrackingMode::Flights) ? "flights" : "area";
    doc["uptimeS"] = (uint32_t)(millis() / 1000);
    String statusJson;
    serializeJson(doc, statusJson);

    const ControlClient::Outcome o =
        ControlClient::checkIn(g_settings.serverUrl, g_settings.controlToken, statusJson);

    if (o.error.length())
    {
        // One line, not a note on /api/status: a control server being briefly
        // unreachable must not look like the flight fetch failing, which is the
        // field a person actually reads to judge whether the wall is working.
        Serial.printf("[control] check-in failed: %s\n", o.error.c_str());
        return;
    }

    if (o.settingsChanged)
        g_controlSettingsChanged = true;

    // Updates before restart, and restart last: a batch containing both should
    // do the work and THEN reboot, not reboot away from it.
    if (o.updateUi)
    {
        const AssetUpdater::FetchResult r = AssetUpdater::updateUi(g_settings.serverUrl);
        Serial.printf("[control] ui update: %s\n", r.ok ? (r.changed ? "updated" : "already current") : r.error.c_str());
    }
    if (o.updateFirmware)
    {
        const FirmwareUpdater::Available a = FirmwareUpdater::check(g_settings.serverUrl);
        if (!a.ok)
            Serial.printf("[control] firmware check failed: %s\n", a.error.c_str());
        else if (a.version == FirmwareUpdater::runningVersion())
            Serial.println("[control] firmware already current");
        else
        {
            // Reboots on success, so nothing after this runs.
            const FirmwareUpdater::ApplyResult r = FirmwareUpdater::apply(g_settings.serverUrl, a);
            Serial.printf("[control] firmware update failed: %s\n", r.error.c_str());
        }
    }
    if (o.restart)
    {
        Serial.println("[control] restarting on request");
        delay(200);
        ESP.restart();
    }
}

// Returns true when loop() should return early because the panel is dark.
//
// g_appliedBrightness is applyBrightness()'s resolved output -- base setting,
// night schedule, ambient sensor, button ramp and the off toggle all folded in
// -- so this covers every reason the panel is off.
//
// It is NOT dormant on shipped defaults, and an earlier version of this comment
// claiming otherwise was wrong. The night schedule does default off (Settings.h:
// schedule.enabled = false, nightBrightness = 5), but two other paths reach 0
// without anyone touching it:
//   - the ambient sensor: lightSensorEnabled = true and lightSensorDimInstead =
//     false by default, so isDark() blanks the panel outright;
//   - the off toggle: g_panelOff, reachable from button A with buttonsEnabled
//     = true by default.
// The sensor is the one to watch. HANDOFF records a mis-sited TCS3472 reading
// ~24 in a lit room against a 500-count threshold, which means a sensor in the
// wrong PLACE now halts fetching as well as blanking the panel. That is why the
// web API keeps serving through suppression and reports lightLevel/lightDark
// alongside the "panel dark - fetch paused" note set below: the cause has to
// stay visible, or this is indistinguishable from a hung device.
//
// With the night schedule ON at nightBrightness 0, the 22:00-07:00 window is
// 9h * 3600s / 30s-interval =
// 1080 fetches a night rendering to nothing, each a TLS handshake on a link
// that is measurably fragile: the HUB75 I2S clock degrades WiFi, and 8 MHz
// with a reseated ribbon is the usable floor.
//
// MUST be called after applyBrightness() earlier in loop(), or it reads a
// stale brightness on the very pass where it changes -- the wake pass.
//
// Deliberately never touches g_consecutiveFailures/g_consecutiveEmpty:
// suppression is not failure, and polluting them would start the first fetch
// after a dark night at the 300s backoff cap.
static bool fetchSuppressedWhileDark()
{
    // Pass g_appliedBrightness straight through. It is an int whose -1 means
    // "not applied yet", and decideIdle treats any negative as LIT -- do NOT
    // clamp it to 0 here. Clamping to 0 would mark the pass suppressed, and
    // the NEXT pass would then force a fetch AND discard the held flights,
    // blanking the wall from a momentary sentinel. handleButtons() resolves
    // the same sentinel the same way, to a lit value.
    const IdleDecision idle = decideIdle(
        g_appliedBrightness, g_fetchSuppressed,
        (uint32_t)g_lastGoodFetchMs, (uint32_t)millis(), (uint32_t)staleWindowMs());

    const bool wasSuppressed = g_fetchSuppressed;
    // suppressFetch IS the next pass's wasSuppressed -- one bit, not two.
    g_fetchSuppressed = idle.suppressFetch;

    if (idle.discardFlights && !g_lastFlights.empty())
    {
        // Woke to a set older than the stale window. Clearing shows the
        // no-flights card for the length of one fetch (see clearStaleFlights --
        // it is not the loading card) rather than aircraft that have landed.
        clearStaleFlights("Woke with stale flights; clearing and refetching");
    }
    if (idle.forceFetch)
    {
        // Fetch on this pass rather than waiting out the interval. Load-bearing
        // only for a SHORT dark period: after a real night g_lastFetchMs is
        // already hours stale, because the gate below skips the very block that
        // updates it, so the interval has long since elapsed and this changes
        // nothing. What it actually covers is a brief blank -- a button toggle,
        // or the ambient reading crossing its hysteresis band -- where the held
        // flights are still inside the stale window and nothing was discarded.
        // It does bypass the failure/empty ladders for that one fetch. Bounded
        // on both sides: the toggle is a deliberate press where refreshing at
        // once is the point, and LightSensor's hysteresis band is precisely what
        // stops the sensor flapping across the threshold.
        g_lastFetchMs = 0;
    }

    if (idle.suppressFetch && !wasSuppressed)
    {
        // Edge-triggered: one line per dark period, not one per pass. A silent
        // skip would leave /api/status reporting "fetch ok" next to flights
        // hours stale for the whole dark stretch -- the same failure mode the
        // server-side quiet-hours skip logs against (flights.ts/server.ts).
        Serial.println("Panel dark; pausing fetches until it wakes");
        g_web.setLastNote("panel dark - fetch paused");
    }

    return idle.suppressFetch;
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
        flushSettingsIfDirty();
    g_web.handle();

    if (g_web.consumeRestartRequested())
    {
        Serial.println("Restart requested via web UI");
        flushSettingsIfDirty();
        delay(200);
        ESP.restart();
    }

    // Bitwise |, NOT ||. Both flags are one-shot and must BOTH be drained every
    // pass: short-circuiting would leave the console's set while the web's was
    // true, so a console change made in the same pass as a web change would be
    // silently swallowed until the next unrelated web save.
    const bool controlChanged = g_controlSettingsChanged;
    g_controlSettingsChanged = false;
    if (g_web.consumeSettingsChanged() | g_console.consumeSettingsChanged() | controlChanged)
    {
        // Someone is actively provisioning: restart the AP retry window below.
        // Deliberately keyed on a SETTINGS WRITE rather than on
        // softAPgetStationNum(), because a phone that auto-rejoins a remembered
        // open "FlightWall-Setup" holds the station count above zero forever --
        // a guard meant to protect a setup session would have re-created the
        // very stranding this is here to end.
        if (g_apMode)
            g_apSinceMs = millis();
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
    if (g_settings.lightSensorEnabled)
    {
        if (nowMs - g_lastLightMs >= 500)
        {
            g_lastLightMs = nowMs;
            g_light.update();
            g_web.setLightStatus(g_light.level(), g_light.isDark());
        }
    }
    else
    {
        // Publish "not consulted" rather than leaving the last verdict standing.
        //
        // Sampling stops the moment the sensor is switched off, so whatever it
        // last decided used to sit in /api/status forever. Disabling a sensor
        // that had just called the room dark left the API reporting
        // lightDark:true and lightLevel:0 indefinitely -- a value nothing was
        // acting on any more, presented identically to a live one, on the only
        // diagnostic channel this device has. It sent a real investigation
        // after the sensor while the panel was actually off for another reason
        // entirely. -1 is the same "no reading" the sensor itself reports when
        // it cannot be read.
        g_web.setLightStatus(-1, false);
    }
    applyBrightness();
    // Publish the RESOLVED state right after it is computed, so the API can
    // explain a dark panel instead of merely showing settings that say it
    // should be lit.
    g_web.setPanelState(g_appliedBrightness, g_panelOff, g_manualBrightness);

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
                flushSettingsIfDirty();
                delay(100);
                ESP.restart();
            }
        }
    }
    else
    {
        // AP MODE IS NOT ABSORBING ANY MORE.
        //
        // g_apMode was set once and never cleared by anything, and it gates the
        // whole self-heal block above -- so once the device fell back to the
        // setup AP it stayed there until a human power-cycled it. Reaching that
        // state needs no attacker and no misconfiguration: a power cut that
        // restores mains to the ESP32 before the router finishes booting expires
        // the 30s STA window, and that is enough. The device then holds working
        // credentials while broadcasting an OPEN network with a wildcard captive
        // portal that pushes the config page at any phone which joins.
        //
        // Only retry when there is something to retry WITH. With no credentials
        // stored this is genuine first-time provisioning and the AP must stay up
        // indefinitely -- rebooting would just loop.
        if (!g_settings.hasWifi())
        {
            g_apSinceMs = 0;
        }
        else
        {
            if (g_apSinceMs == 0)
                g_apSinceMs = nowMs;
            else if (nowMs - g_apSinceMs > kApRetryAfterMs)
            {
                Serial.println("Setup AP up >10min with credentials stored; restarting to retry WiFi");
                flushSettingsIfDirty();
                delay(100);
                ESP.restart();
            }
        }
    }

    // In AP setup mode we only serve the web UI (no network for fetching).
    if (g_apMode || WiFi.status() != WL_CONNECTED)
    {
        // Duty-cycle the panel against the radio. The HUB75 DMA starves the
        // WiFi peripheral badly enough that clients cannot associate at all
        // (measured: the AP appeared in 1 scan in 3 with the panel running, 6
        // of 6 with it stopped), so the panel spends most of setup dark -- but
        // not all of it, or the wall just looks broken. See the constants.
        if (g_apMode && g_apStartedMs != 0)
        {
            const unsigned long lit = g_apDmaStopped ? kApPanelDarkMs : g_apPanelLitMs;
            // Tick the countdown once a second while the panel is lit. Cheap --
            // one canvas render against a loop that is otherwise doing nothing
            // but serving a 1KB form -- and it is the only feedback there is
            // that the blackout is a timer rather than a failure.
            if (!g_apDmaStopped && millis() - g_apCountdownMs >= 1000UL)
            {
                g_apCountdownMs = millis();
                const unsigned long elapsed = millis() - g_apStartedMs;
                const unsigned long left = (elapsed >= lit) ? 0UL : (lit - elapsed);
                g_display.displayMessage(setupScreenText((left + 999UL) / 1000UL));
            }
            if (millis() - g_apStartedMs >= lit)
            {
                g_apStartedMs = millis();
                if (!g_apDmaStopped)
                {
                    g_apDmaStopped = true;
                    Serial.println("[setup] panel dark; radio has the bus");
                    g_display.stopOutput();
                }
                else
                {
                    g_apDmaStopped = false;
                    // Every lit period after the first one is a full minute:
                    // the 30s opener exists only so the first look is quick.
                    g_apPanelLitMs = kApPanelLitMs;
                    Serial.println("[setup] panel lit for a minute; wifi will struggle until it is dark again");
                    g_display.startOutput();
                    g_apCountdownMs = 0; // force an immediate countdown redraw
                    g_display.displayMessage(setupScreenText(kApPanelLitMs / 1000)); // resumes blank
                }
            }
        }
        delay(5);
        return;
    }

    // Skip the fetch/render cadence entirely while the panel is dark. Must run
    // after applyBrightness() above -- see fetchSuppressedWhileDark() for why,
    // and why a suppressed pass must never touch g_consecutiveFailures or
    // g_consecutiveEmpty.
    if (fetchSuppressedWhileDark())
    {
        delay(5);
        return;
    }

    // Both pressure signals, combined by max() rather than precedence -- see
    // utils/FetchCadence.h for why that distinction is load-bearing and for the
    // measurements behind each ladder's cap.
    const unsigned long intervalMs = fetchIntervalMs(
        (unsigned long)g_settings.fetchIntervalSeconds * 1000UL,
        g_consecutiveFailures,
        g_consecutiveEmpty);

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
