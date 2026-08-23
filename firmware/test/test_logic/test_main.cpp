/*
Unit tests for the pure logic that doesn't need the network or display:
- Filters::altitudeInBand / airlineAllowed
- Settings JSON parse + round-trip (toJson/fromJson), including normalization
  (trim/uppercase of tracked flights & allow-list) and partial updates.

Run on a connected ESP32 with:  pio test
Compile-only check (no board):   pio test --without-uploading --without-testing
*/
#include <Arduino.h>
#include <unity.h>
#include <vector>

#include "core/Filters.h"
#include "core/Settings.h"
#include "models/AirportInfo.h"

// ---- Filters --------------------------------------------------------------

void test_altitude_band()
{
    // Unknown altitude always passes.
    TEST_ASSERT_TRUE(Filters::altitudeInBand(NAN, 1000, 40000));
    // Inside band (inclusive bounds).
    TEST_ASSERT_TRUE(Filters::altitudeInBand(5000, 1000, 40000));
    TEST_ASSERT_TRUE(Filters::altitudeInBand(1000, 1000, 40000));
    TEST_ASSERT_TRUE(Filters::altitudeInBand(40000, 1000, 40000));
    // Outside band.
    TEST_ASSERT_FALSE(Filters::altitudeInBand(500, 1000, 40000));
    TEST_ASSERT_FALSE(Filters::altitudeInBand(45000, 1000, 40000));
}

void test_airline_allow()
{
    std::vector<String> empty;
    TEST_ASSERT_TRUE(Filters::airlineAllowed(empty, "UAL", "UA", "United"));

    std::vector<String> allow;
    allow.push_back("dal"); // lower-case on purpose -> case-insensitive match
    allow.push_back("AAL");
    TEST_ASSERT_TRUE(Filters::airlineAllowed(allow, "DAL", "DL", "Delta"));
    TEST_ASSERT_TRUE(Filters::airlineAllowed(allow, "AAL", "AA", "American"));
    TEST_ASSERT_FALSE(Filters::airlineAllowed(allow, "UAL", "UA", "United"));
}

// ---- Settings -------------------------------------------------------------

void test_settings_parse()
{
    g_settings.seedDefaults();
    const char *json =
        "{\"tracking\":{\"mode\":\"flights\",\"centerLat\":40.5,\"radiusKm\":25,"
        "\"trackedFlights\":[\" ual123 \",\"baw286\"]},"
        "\"display\":{\"brightness\":99,\"maxFlights\":3},"
        "\"filters\":{\"minAltitudeFt\":1000,\"maxAltitudeFt\":40000,\"airlineAllowList\":[\"dal\"]},"
        "\"layout\":{\"showAltitude\":true}}";

    TEST_ASSERT_TRUE(g_settings.fromJson(String(json)));
    TEST_ASSERT_EQUAL(TrackingMode::Flights, g_settings.mode);
    TEST_ASSERT_EQUAL_FLOAT(40.5, g_settings.centerLat);
    TEST_ASSERT_EQUAL_FLOAT(25.0, g_settings.radiusKm);
    TEST_ASSERT_EQUAL(99, g_settings.brightness);
    TEST_ASSERT_EQUAL(3, g_settings.maxFlights);
    TEST_ASSERT_TRUE(g_settings.layout.showAltitude);

    // Tracked flights are trimmed + upper-cased.
    TEST_ASSERT_EQUAL_INT(2, (int)g_settings.trackedFlights.size());
    TEST_ASSERT_TRUE(g_settings.trackedFlights[0] == "UAL123");
    TEST_ASSERT_TRUE(g_settings.trackedFlights[1] == "BAW286");

    // Allow-list normalized to upper-case.
    TEST_ASSERT_EQUAL_INT(1, (int)g_settings.filters.airlineAllowList.size());
    TEST_ASSERT_TRUE(g_settings.filters.airlineAllowList[0] == "DAL");
}

void test_settings_partial_update_preserves_other_fields()
{
    g_settings.seedDefaults();
    double originalLat = g_settings.centerLat;
    g_settings.brightness = 7;

    // Update only one display field; everything else must remain.
    TEST_ASSERT_TRUE(g_settings.fromJson(String("{\"display\":{\"brightness\":123}}")));
    TEST_ASSERT_EQUAL(123, g_settings.brightness);
    TEST_ASSERT_EQUAL_FLOAT(originalLat, g_settings.centerLat);
}

void test_settings_roundtrip()
{
    g_settings.seedDefaults();
    g_settings.mode = TrackingMode::Flights;
    g_settings.brightness = 88;
    g_settings.maxFlights = 4;
    g_settings.trackedFlights.clear();
    g_settings.trackedFlights.push_back("UAL1");
    g_settings.trackedFlights.push_back("DAL2");
    g_settings.layout.showSpeed = true;
    g_settings.schedule.enabled = true;
    g_settings.schedule.nightStartHour = 23;

    String out = g_settings.toJson();

    Settings tmp;
    tmp.seedDefaults();
    TEST_ASSERT_TRUE(tmp.fromJson(out));
    TEST_ASSERT_EQUAL(TrackingMode::Flights, tmp.mode);
    TEST_ASSERT_EQUAL(88, tmp.brightness);
    TEST_ASSERT_EQUAL(4, tmp.maxFlights);
    TEST_ASSERT_EQUAL_INT(2, (int)tmp.trackedFlights.size());
    TEST_ASSERT_TRUE(tmp.trackedFlights[1] == "DAL2");
    TEST_ASSERT_TRUE(tmp.layout.showSpeed);
    TEST_ASSERT_TRUE(tmp.schedule.enabled);
    TEST_ASSERT_EQUAL(23, tmp.schedule.nightStartHour);
}

// Every recognised positionSource string must survive fromJson -> toJson unchanged.
// Guards the string<->enum table in Settings.cpp staying in sync in both directions
// (a typo in one direction round-trips silently otherwise).
void test_position_source_roundtrip()
{
    struct Case { const char *str; PositionSource src; };
    const Case cases[] = {
        {"opensky", PositionSource::OpenSky},
        {"fr24", PositionSource::FlightRadar24},
        {"adsblol", PositionSource::AdsbLol},
        {"server", PositionSource::FlightWallServer},
    };
    for (const auto &c : cases)
    {
        g_settings.seedDefaults();
        String in = String("{\"api\":{\"positionSource\":\"") + c.str + "\"}}";
        TEST_ASSERT_TRUE(g_settings.fromJson(in));
        TEST_ASSERT_EQUAL((int)c.src, (int)g_settings.positionSource);

        String out = g_settings.toJson();
        String needle = String("\"positionSource\":\"") + c.str + "\"";
        TEST_ASSERT_TRUE(out.indexOf(needle) >= 0);
    }
}

// An unrecognised string must fall back to the named OpenSky enumerator, not to
// "whatever value happens to be 0" (they are the same value today, but only one
// of those is a real guarantee). Starting from FlightWallServer -- a non-zero,
// non-default source -- means a fallback that just leaves positionSource
// untouched would also fail this, not only one that lands on the wrong enumerator.
void test_position_source_unknown_falls_back_to_opensky()
{
    g_settings.seedDefaults();
    g_settings.positionSource = PositionSource::FlightWallServer;
    TEST_ASSERT_TRUE(g_settings.fromJson(String("{\"api\":{\"positionSource\":\"bogus\"}}")));
    TEST_ASSERT_EQUAL((int)PositionSource::OpenSky, (int)g_settings.positionSource);
}

// serverUrl is normalised on load: no trailing slash, however many were sent,
// down to and including a URL that is nothing else.
void test_server_url_trailing_slash_normalized()
{
    g_settings.seedDefaults();
    TEST_ASSERT_TRUE(g_settings.fromJson(String("{\"api\":{\"serverUrl\":\"https://example.com/flightwall/\"}}")));
    TEST_ASSERT_TRUE(g_settings.serverUrl == "https://example.com/flightwall");

    // Multiple trailing slashes are all stripped, not just the outermost one.
    TEST_ASSERT_TRUE(g_settings.fromJson(String("{\"api\":{\"serverUrl\":\"https://example.com///\"}}")));
    TEST_ASSERT_TRUE(g_settings.serverUrl == "https://example.com");

    // Nothing but slashes must reduce to empty, not underflow/loop forever.
    TEST_ASSERT_TRUE(g_settings.fromJson(String("{\"api\":{\"serverUrl\":\"///\"}}")));
    TEST_ASSERT_TRUE(g_settings.serverUrl == "");

    // No trailing slash: left alone.
    TEST_ASSERT_TRUE(g_settings.fromJson(String("{\"api\":{\"serverUrl\":\"https://example.com\"}}")));
    TEST_ASSERT_TRUE(g_settings.serverUrl == "https://example.com");
}

// ---- redacted settings projection ------------------------------------------

// GET /api/settings is unauthenticated and reachable by any LAN peer; it used
// to return the WiFi PSK, the OpenSky secret and the AeroAPI key in plaintext.
void test_public_json_omits_secrets()
{
    g_settings.seedDefaults();
    g_settings.wifiPassword = "hunter2";
    g_settings.openSkyClientSecret = "osky-secret";
    g_settings.aeroApiKey = "aero-key";

    const String pub = g_settings.toJsonPublic();
    TEST_ASSERT_TRUE(pub.indexOf("hunter2") < 0);
    TEST_ASSERT_TRUE(pub.indexOf("osky-secret") < 0);
    TEST_ASSERT_TRUE(pub.indexOf("aero-key") < 0);
    // Replaced by booleans, which is all the UI needs.
    TEST_ASSERT_TRUE(pub.indexOf("wifiPasswordSet") >= 0);
    TEST_ASSERT_TRUE(pub.indexOf("openSkyClientSecretSet") >= 0);
    TEST_ASSERT_TRUE(pub.indexOf("aeroApiKeySet") >= 0);
    // Non-secret fields still travel.
    TEST_ASSERT_TRUE(pub.indexOf("wifiSsid") >= 0);
    TEST_ASSERT_TRUE(pub.indexOf("openSkyClientId") >= 0);
}

// The PERSISTENCE format must stay complete -- save() writes toJson(), and a
// redacted file would lose the credentials on the next boot.
void test_persisted_json_still_carries_secrets()
{
    g_settings.seedDefaults();
    g_settings.wifiPassword = "hunter2";
    const String full = g_settings.toJson();
    TEST_ASSERT_TRUE(full.indexOf("hunter2") >= 0);
}

// An empty secret means "unchanged", never "clear". Without this, a browser
// holding a cached OLD index.html against new firmware would post "" for a
// password it could no longer read and strand the device in the open setup AP.
void test_empty_secret_does_not_wipe_a_stored_one()
{
    g_settings.seedDefaults();
    g_settings.wifiPassword = "hunter2";
    g_settings.aeroApiKey = "aero-key";

    TEST_ASSERT_TRUE(g_settings.fromJson(String(
        "{\"network\":{\"wifiSsid\":\"Home\",\"wifiPassword\":\"\"},"
        "\"api\":{\"aeroApiKey\":\"\"}}")));

    TEST_ASSERT_TRUE(g_settings.wifiPassword == "hunter2");
    TEST_ASSERT_TRUE(g_settings.aeroApiKey == "aero-key");
    TEST_ASSERT_TRUE(g_settings.wifiSsid == "Home"); // non-secrets still apply
}

// A non-empty secret still replaces the stored one.
void test_nonempty_secret_replaces()
{
    g_settings.seedDefaults();
    g_settings.wifiPassword = "old";
    TEST_ASSERT_TRUE(g_settings.fromJson(String("{\"network\":{\"wifiPassword\":\"new\"}}")));
    TEST_ASSERT_TRUE(g_settings.wifiPassword == "new");
}

// ---- AirportInfo::displayCode ----------------------------------------------

// The rule three consumers used to re-derive, one of them wrongly. The case
// that mattered is the third: a server- or FR24-sourced flight carries IATA
// only, and reading code_icao alone made the panel drop the route line
// entirely.
void test_airport_display_code()
{
    AirportInfo both;
    both.code_icao = "KJFK";
    both.code_iata = "JFK";
    TEST_ASSERT_TRUE(both.displayCode() == "JFK"); // IATA preferred

    AirportInfo icaoOnly;
    icaoOnly.code_icao = "KJFK";
    TEST_ASSERT_TRUE(icaoOnly.displayCode() == "KJFK"); // falls back

    AirportInfo iataOnly; // what the server and FR24 paths actually produce
    iataOnly.code_iata = "JFK";
    TEST_ASSERT_TRUE(iataOnly.displayCode() == "JFK");

    AirportInfo neither;
    TEST_ASSERT_TRUE(neither.displayCode() == "");
}

// ---- seedDefaults ---------------------------------------------------------

// The `erase` command's contract. seedDefaults() used to be a hand-maintained
// second copy of ~30 field assignments, and it had silently omitted serverUrl
// and positionSource -- so "reset to defaults" left a bad server URL in place
// and wrote it back, useless exactly when a bad server URL is what you are
// escaping. Dirty EVERY field this test can reach, then assert the reset really
// resets, rather than spot-checking the ones that happened to be listed.
void test_seed_defaults_resets_every_field()
{
    g_settings.seedDefaults();

    // The two the old implementation forgot.
    g_settings.serverUrl = "https://stale.example";
    g_settings.positionSource = PositionSource::FlightWallServer;
    // A spread across every other group, including nested structs.
    g_settings.centerLat = 1.0;
    g_settings.centerLon = 2.0;
    g_settings.brightness = 99;
    g_settings.maxFlights = 3;
    g_settings.mode = TrackingMode::Flights;
    g_settings.lightSensorEnabled = false;
    g_settings.buttonsEnabled = false;
    g_settings.panelChain = 7;
    g_settings.layout.showRoute = false;
    g_settings.filters.excludeOnGround = false;
    g_settings.schedule.timezone = "PST8PDT";
    g_settings.trackedFlights.push_back("DAL1");

    g_settings.seedDefaults();

    TEST_ASSERT_TRUE(g_settings.serverUrl == "");
    TEST_ASSERT_EQUAL((int)PositionSource::OpenSky, (int)g_settings.positionSource);
    TEST_ASSERT_EQUAL((int)TrackingMode::Area, (int)g_settings.mode);
    TEST_ASSERT_TRUE(g_settings.lightSensorEnabled);
    TEST_ASSERT_TRUE(g_settings.buttonsEnabled);
    TEST_ASSERT_TRUE(g_settings.layout.showRoute);
    TEST_ASSERT_TRUE(g_settings.filters.excludeOnGround);
    TEST_ASSERT_TRUE(g_settings.schedule.timezone == "UTC0");
    TEST_ASSERT_EQUAL(0, (int)g_settings.trackedFlights.size());
}

// A default-constructed Settings and seedDefaults() must agree with the config
// headers, which is what the two lists failed at: Settings.h said San Francisco
// while UserConfiguration.h said JFK, and UserConfiguration.h's own comment
// ("They must agree") was the only thing asserting it.
void test_seed_defaults_matches_config_constants()
{
    g_settings.seedDefaults();

    TEST_ASSERT_EQUAL_DOUBLE(UserConfiguration::CENTER_LAT, g_settings.centerLat);
    TEST_ASSERT_EQUAL_DOUBLE(UserConfiguration::CENTER_LON, g_settings.centerLon);
    TEST_ASSERT_EQUAL_DOUBLE(UserConfiguration::RADIUS_KM, g_settings.radiusKm);
    TEST_ASSERT_EQUAL(UserConfiguration::DISPLAY_BRIGHTNESS, g_settings.brightness);
    TEST_ASSERT_EQUAL(UserConfiguration::MAX_FLIGHTS, g_settings.maxFlights);
    TEST_ASSERT_EQUAL(UserConfiguration::TEXT_COLOR_R, g_settings.textColorR);
    TEST_ASSERT_EQUAL(TimingConfiguration::DISPLAY_CYCLE_SECONDS, g_settings.cycleSeconds);
    TEST_ASSERT_EQUAL(TimingConfiguration::FETCH_INTERVAL_SECONDS, g_settings.fetchIntervalSeconds);
    TEST_ASSERT_EQUAL(HardwareConfiguration::PANEL_RES_X, g_settings.panelResX);
    TEST_ASSERT_EQUAL(HardwareConfiguration::PANEL_RES_Y, g_settings.panelResY);
    TEST_ASSERT_EQUAL(HardwareConfiguration::PANEL_CHAIN, g_settings.panelChain);

    // And a fresh instance must equal a reset one on the same fields -- the two
    // paths that used to disagree.
    Settings fresh;
    TEST_ASSERT_EQUAL_DOUBLE(fresh.centerLat, g_settings.centerLat);
    TEST_ASSERT_EQUAL_DOUBLE(fresh.centerLon, g_settings.centerLon);
    TEST_ASSERT_EQUAL((int)fresh.positionSource, (int)g_settings.positionSource);
    TEST_ASSERT_TRUE(fresh.serverUrl == g_settings.serverUrl);
}

// ---- runner ---------------------------------------------------------------

void setup()
{
    delay(2000); // allow the USB serial monitor to attach
    UNITY_BEGIN();
    RUN_TEST(test_altitude_band);
    RUN_TEST(test_airline_allow);
    RUN_TEST(test_settings_parse);
    RUN_TEST(test_settings_partial_update_preserves_other_fields);
    RUN_TEST(test_settings_roundtrip);
    RUN_TEST(test_position_source_roundtrip);
    RUN_TEST(test_position_source_unknown_falls_back_to_opensky);
    RUN_TEST(test_server_url_trailing_slash_normalized);
    RUN_TEST(test_public_json_omits_secrets);
    RUN_TEST(test_persisted_json_still_carries_secrets);
    RUN_TEST(test_empty_secret_does_not_wipe_a_stored_one);
    RUN_TEST(test_nonempty_secret_replaces);
    RUN_TEST(test_airport_display_code);
    RUN_TEST(test_seed_defaults_resets_every_field);
    RUN_TEST(test_seed_defaults_matches_config_constants);
    UNITY_END();
}

void loop() {}
