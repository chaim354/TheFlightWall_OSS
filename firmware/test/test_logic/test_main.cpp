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
    UNITY_END();
}

void loop() {}
