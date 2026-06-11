/*
Purpose: Implementation of the runtime Settings store (LittleFS + ArduinoJson).
*/
#include "core/Settings.h"

#include <LittleFS.h>
#include <ArduinoJson.h>

#include "config/UserConfiguration.h"
#include "config/WiFiConfiguration.h"
#include "config/TimingConfiguration.h"
#include "config/HardwareConfiguration.h"
#include "config/APIConfiguration.h"

Settings g_settings;

static const char *kSettingsPath = "/settings.json";

void Settings::seedDefaults()
{
    wifiSsid = WiFiConfiguration::WIFI_SSID;
    wifiPassword = WiFiConfiguration::WIFI_PASSWORD;

    openSkyClientId = APIConfiguration::OPENSKY_CLIENT_ID;
    openSkyClientSecret = APIConfiguration::OPENSKY_CLIENT_SECRET;
    aeroApiKey = APIConfiguration::AEROAPI_KEY;

    enrichmentSource = EnrichmentSource::Adsbdb;
    enrichmentCacheSeconds = 600;
    enrichmentFallbackToAeroApi = true;

    mode = TrackingMode::Area;
    centerLat = UserConfiguration::CENTER_LAT;
    centerLon = UserConfiguration::CENTER_LON;
    radiusKm = UserConfiguration::RADIUS_KM;
    trackedFlights.clear();

    brightness = UserConfiguration::DISPLAY_BRIGHTNESS;
    textColorR = UserConfiguration::TEXT_COLOR_R;
    textColorG = UserConfiguration::TEXT_COLOR_G;
    textColorB = UserConfiguration::TEXT_COLOR_B;
    maxFlights = 5;
    cycleSeconds = TimingConfiguration::DISPLAY_CYCLE_SECONDS;
    fetchIntervalSeconds = TimingConfiguration::FETCH_INTERVAL_SECONDS;

    layout = DisplayLayout();
    filters = AircraftFilters();
    schedule = BrightnessSchedule();

    panelResX = HardwareConfiguration::PANEL_RES_X;
    panelResY = HardwareConfiguration::PANEL_RES_Y;
    panelChain = HardwareConfiguration::PANEL_CHAIN;
}

bool Settings::begin()
{
    if (!LittleFS.begin(true))
    {
        Serial.println("Settings: LittleFS mount failed; using compile-time defaults");
        seedDefaults();
        return false;
    }

    if (!LittleFS.exists(kSettingsPath))
    {
        Serial.println("Settings: no saved settings, seeding defaults");
        seedDefaults();
        save();
        return true;
    }

    if (!load())
    {
        Serial.println("Settings: load failed, seeding defaults");
        seedDefaults();
        return false;
    }
    return true;
}

bool Settings::load()
{
    File f = LittleFS.open(kSettingsPath, "r");
    if (!f)
        return false;
    String content = f.readString();
    f.close();
    return fromJson(content);
}

bool Settings::save() const
{
    File f = LittleFS.open(kSettingsPath, "w");
    if (!f)
    {
        Serial.println("Settings: failed to open settings file for write");
        return false;
    }
    String out = toJson();
    f.print(out);
    f.close();
    return true;
}

String Settings::toJson() const
{
    DynamicJsonDocument doc(8192);

    JsonObject net = doc.createNestedObject("network");
    net["wifiSsid"] = wifiSsid;
    net["wifiPassword"] = wifiPassword;

    JsonObject api = doc.createNestedObject("api");
    api["openSkyClientId"] = openSkyClientId;
    api["openSkyClientSecret"] = openSkyClientSecret;
    api["aeroApiKey"] = aeroApiKey;
    api["enrichmentSource"] = (enrichmentSource == EnrichmentSource::AeroApi) ? "aeroapi"
                              : (enrichmentSource == EnrichmentSource::Off) ? "off"
                                                                            : "adsbdb";
    api["enrichmentCacheSeconds"] = enrichmentCacheSeconds;
    api["enrichmentFallbackToAeroApi"] = enrichmentFallbackToAeroApi;

    JsonObject track = doc.createNestedObject("tracking");
    track["mode"] = (mode == TrackingMode::Flights) ? "flights" : "area";
    track["centerLat"] = centerLat;
    track["centerLon"] = centerLon;
    track["radiusKm"] = radiusKm;
    JsonArray flights = track.createNestedArray("trackedFlights");
    for (const auto &id : trackedFlights)
        flights.add(id);

    JsonObject disp = doc.createNestedObject("display");
    disp["brightness"] = brightness;
    disp["textColorR"] = textColorR;
    disp["textColorG"] = textColorG;
    disp["textColorB"] = textColorB;
    disp["maxFlights"] = maxFlights;
    disp["cycleSeconds"] = cycleSeconds;
    disp["fetchIntervalSeconds"] = fetchIntervalSeconds;

    JsonObject lay = doc.createNestedObject("layout");
    lay["showAirlineFlight"] = layout.showAirlineFlight;
    lay["showRoute"] = layout.showRoute;
    lay["showAircraft"] = layout.showAircraft;
    lay["showAltitude"] = layout.showAltitude;
    lay["showSpeed"] = layout.showSpeed;
    lay["showHeading"] = layout.showHeading;
    lay["showVerticalRate"] = layout.showVerticalRate;

    JsonObject filt = doc.createNestedObject("filters");
    filt["minAltitudeFt"] = filters.minAltitudeFt;
    filt["maxAltitudeFt"] = filters.maxAltitudeFt;
    filt["excludeOnGround"] = filters.excludeOnGround;
    JsonArray allow = filt.createNestedArray("airlineAllowList");
    for (const auto &a : filters.airlineAllowList)
        allow.add(a);

    JsonObject sch = doc.createNestedObject("schedule");
    sch["enabled"] = schedule.enabled;
    sch["dayBrightness"] = schedule.dayBrightness;
    sch["nightBrightness"] = schedule.nightBrightness;
    sch["nightStartHour"] = schedule.nightStartHour;
    sch["nightEndHour"] = schedule.nightEndHour;
    sch["timezoneOffsetMinutes"] = schedule.timezoneOffsetMinutes;

    JsonObject hw = doc.createNestedObject("hardware");
    hw["panelResX"] = panelResX;
    hw["panelResY"] = panelResY;
    hw["panelChain"] = panelChain;

    String out;
    serializeJson(doc, out);
    return out;
}

bool Settings::fromJson(const String &in)
{
    DynamicJsonDocument doc(8192);
    DeserializationError err = deserializeJson(doc, in);
    if (err)
    {
        Serial.print("Settings: JSON parse error: ");
        Serial.println(err.c_str());
        return false;
    }

    // Start from current values so partial updates are allowed.
    if (doc.containsKey("network"))
    {
        JsonObject net = doc["network"];
        if (net.containsKey("wifiSsid"))
            wifiSsid = net["wifiSsid"].as<String>();
        if (net.containsKey("wifiPassword"))
            wifiPassword = net["wifiPassword"].as<String>();
    }

    if (doc.containsKey("api"))
    {
        JsonObject api = doc["api"];
        if (api.containsKey("openSkyClientId"))
            openSkyClientId = api["openSkyClientId"].as<String>();
        if (api.containsKey("openSkyClientSecret"))
            openSkyClientSecret = api["openSkyClientSecret"].as<String>();
        if (api.containsKey("aeroApiKey"))
            aeroApiKey = api["aeroApiKey"].as<String>();
        if (api.containsKey("enrichmentSource"))
        {
            String s = api["enrichmentSource"].as<String>();
            enrichmentSource = (s == "aeroapi") ? EnrichmentSource::AeroApi
                               : (s == "off") ? EnrichmentSource::Off
                                              : EnrichmentSource::Adsbdb;
        }
        if (api.containsKey("enrichmentCacheSeconds"))
            enrichmentCacheSeconds = api["enrichmentCacheSeconds"].as<uint32_t>();
        if (api.containsKey("enrichmentFallbackToAeroApi"))
            enrichmentFallbackToAeroApi = api["enrichmentFallbackToAeroApi"].as<bool>();
    }

    if (doc.containsKey("tracking"))
    {
        JsonObject track = doc["tracking"];
        if (track.containsKey("mode"))
            mode = (String(track["mode"].as<const char *>()) == "flights") ? TrackingMode::Flights : TrackingMode::Area;
        if (track.containsKey("centerLat"))
            centerLat = track["centerLat"].as<double>();
        if (track.containsKey("centerLon"))
            centerLon = track["centerLon"].as<double>();
        if (track.containsKey("radiusKm"))
            radiusKm = track["radiusKm"].as<double>();
        if (track.containsKey("trackedFlights"))
        {
            trackedFlights.clear();
            for (JsonVariant v : track["trackedFlights"].as<JsonArray>())
            {
                String id = v.as<String>();
                id.trim();
                id.toUpperCase();
                if (id.length())
                    trackedFlights.push_back(id);
            }
        }
    }

    if (doc.containsKey("display"))
    {
        JsonObject disp = doc["display"];
        if (disp.containsKey("brightness"))
            brightness = disp["brightness"].as<uint8_t>();
        if (disp.containsKey("textColorR"))
            textColorR = disp["textColorR"].as<uint8_t>();
        if (disp.containsKey("textColorG"))
            textColorG = disp["textColorG"].as<uint8_t>();
        if (disp.containsKey("textColorB"))
            textColorB = disp["textColorB"].as<uint8_t>();
        if (disp.containsKey("maxFlights"))
            maxFlights = disp["maxFlights"].as<uint8_t>();
        if (disp.containsKey("cycleSeconds"))
            cycleSeconds = disp["cycleSeconds"].as<uint32_t>();
        if (disp.containsKey("fetchIntervalSeconds"))
            fetchIntervalSeconds = disp["fetchIntervalSeconds"].as<uint32_t>();
    }

    if (doc.containsKey("layout"))
    {
        JsonObject lay = doc["layout"];
        layout.showAirlineFlight = lay["showAirlineFlight"] | layout.showAirlineFlight;
        layout.showRoute = lay["showRoute"] | layout.showRoute;
        layout.showAircraft = lay["showAircraft"] | layout.showAircraft;
        layout.showAltitude = lay["showAltitude"] | layout.showAltitude;
        layout.showSpeed = lay["showSpeed"] | layout.showSpeed;
        layout.showHeading = lay["showHeading"] | layout.showHeading;
        layout.showVerticalRate = lay["showVerticalRate"] | layout.showVerticalRate;
    }

    if (doc.containsKey("filters"))
    {
        JsonObject filt = doc["filters"];
        if (filt.containsKey("minAltitudeFt"))
            filters.minAltitudeFt = filt["minAltitudeFt"].as<double>();
        if (filt.containsKey("maxAltitudeFt"))
            filters.maxAltitudeFt = filt["maxAltitudeFt"].as<double>();
        if (filt.containsKey("excludeOnGround"))
            filters.excludeOnGround = filt["excludeOnGround"].as<bool>();
        if (filt.containsKey("airlineAllowList"))
        {
            filters.airlineAllowList.clear();
            for (JsonVariant v : filt["airlineAllowList"].as<JsonArray>())
            {
                String a = v.as<String>();
                a.trim();
                a.toUpperCase();
                if (a.length())
                    filters.airlineAllowList.push_back(a);
            }
        }
    }

    if (doc.containsKey("schedule"))
    {
        JsonObject sch = doc["schedule"];
        if (sch.containsKey("enabled"))
            schedule.enabled = sch["enabled"].as<bool>();
        if (sch.containsKey("dayBrightness"))
            schedule.dayBrightness = sch["dayBrightness"].as<uint8_t>();
        if (sch.containsKey("nightBrightness"))
            schedule.nightBrightness = sch["nightBrightness"].as<uint8_t>();
        if (sch.containsKey("nightStartHour"))
            schedule.nightStartHour = sch["nightStartHour"].as<uint8_t>();
        if (sch.containsKey("nightEndHour"))
            schedule.nightEndHour = sch["nightEndHour"].as<uint8_t>();
        if (sch.containsKey("timezoneOffsetMinutes"))
            schedule.timezoneOffsetMinutes = sch["timezoneOffsetMinutes"].as<int16_t>();
    }

    if (doc.containsKey("hardware"))
    {
        JsonObject hw = doc["hardware"];
        if (hw.containsKey("panelResX"))
            panelResX = hw["panelResX"].as<uint16_t>();
        if (hw.containsKey("panelResY"))
            panelResY = hw["panelResY"].as<uint16_t>();
        if (hw.containsKey("panelChain"))
            panelChain = hw["panelChain"].as<uint8_t>();
    }

    return true;
}
