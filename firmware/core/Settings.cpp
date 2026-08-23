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

// Name <-> enum for the light sensor type. A switch rather than a ternary chain so a
// new type is a visible edit here instead of silently serializing as "analog" — the
// same fall-through hazard LightSensor's dispatch had.
static const char *lightSensorTypeName(LightSensorType t)
{
    switch (t)
    {
    case LightSensorType::BH1750:
        return "bh1750";
    case LightSensorType::TCS3472:
        return "tcs3472";
    case LightSensorType::Analog:
        break;
    }
    return "analog";
}

static LightSensorType lightSensorTypeFromName(const char *name)
{
    if (name)
    {
        const String n(name);
        if (n == "bh1750")
            return LightSensorType::BH1750;
        if (n == "tcs3472")
            return LightSensorType::TCS3472;
    }
    // Unknown/absent -> Analog: the one type that needs no bus and no extra hardware.
    return LightSensorType::Analog;
}

// Round-trips PositionSource through the settings JSON. An unrecognised string
// falls back to OpenSky rather than to whatever enum value happens to be 0 --
// a config written by a NEWER firmware must degrade to the safe default, not to
// an arbitrary source.
static const char *positionSourceToString(PositionSource s)
{
    switch (s)
    {
    case PositionSource::FlightRadar24:    return "fr24";
    case PositionSource::AdsbLol:          return "adsblol";
    case PositionSource::FlightWallServer: return "server";
    case PositionSource::OpenSky:
    default:                               return "opensky";
    }
}

static PositionSource positionSourceFromString(const String &s)
{
    if (s == "fr24")    return PositionSource::FlightRadar24;
    if (s == "adsblol") return PositionSource::AdsbLol;
    if (s == "server")  return PositionSource::FlightWallServer;
    return PositionSource::OpenSky;
}

Settings g_settings;

static const char *kSettingsPath = "/settings.json";

void Settings::seedDefaults()
{
    // Reset to the in-class initialisers -- Settings.h is the single source of
    // truth for every default -- then overlay the five values only Secrets.h can
    // supply. A field added to the struct is now in the reset path automatically;
    // the omission class is unrepresentable rather than merely absent today.
    //
    // This replaces a hand-maintained second copy of ~30 defaults that had
    // already failed twice: it never assigned serverUrl or positionSource at all,
    // so the documented `erase` ("reset to defaults") left a bad server URL in
    // place and wrote it back -- useless precisely when a bad server URL is what
    // you are trying to escape -- and its centerLat/centerLon disagreed with
    // Settings.h's, so which "default location" you got depended on which of the
    // begin() paths had run.
    //
    // Move-assignment: Settings declares no destructor, copy, assignment or
    // virtuals, so this is the implicit move. ~240 bytes of stack for the
    // temporary and a few small allocations, two of which the old code already
    // made via `layout = DisplayLayout()`. Runs at most once per boot.
    *this = Settings();

    // The only values a header initialiser cannot express.
    wifiSsid = WiFiConfiguration::WIFI_SSID;
    wifiPassword = WiFiConfiguration::WIFI_PASSWORD;

    openSkyClientId = APIConfiguration::OPENSKY_CLIENT_ID;
    openSkyClientSecret = APIConfiguration::OPENSKY_CLIENT_SECRET;
    aeroApiKey = APIConfiguration::AEROAPI_KEY;
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
    // Write to a temp file, verify it landed whole, THEN rename over the live file.
    // A truncate-then-write here (the previous behavior) meant a power cut mid-save
    // left a partial /settings.json — losing the WiFi password and API keys and
    // dropping the device into the open setup AP. littlefs's rename atomically
    // replaces the destination, so /settings.json is always either fully the old
    // file or fully the new one.
    const char *kTmpPath = "/settings.tmp";
    String out = toJson();

    File f = LittleFS.open(kTmpPath, "w");
    if (!f)
    {
        Serial.println("Settings: failed to open temp settings file for write");
        return false;
    }
    size_t written = f.print(out);
    f.close();

    if (written != out.length())
    {
        Serial.printf("Settings: short write (%u of %u bytes); keeping previous settings\n",
                      (unsigned)written, (unsigned)out.length());
        LittleFS.remove(kTmpPath);
        return false;
    }

    if (!LittleFS.rename(kTmpPath, kSettingsPath))
    {
        Serial.println("Settings: rename of temp settings file failed");
        LittleFS.remove(kTmpPath);
        return false;
    }
    return true;
}

String Settings::toJson() const
{
    return serialize(false);
}

String Settings::toJsonPublic() const
{
    return serialize(true);
}

String Settings::serialize(bool redactSecrets) const
{
    JsonDocument doc;

    JsonObject net = doc.createNestedObject("network");
    net["wifiSsid"] = wifiSsid;
    if (redactSecrets)
        net["wifiPasswordSet"] = wifiPassword.length() > 0;
    else
        net["wifiPassword"] = wifiPassword;

    JsonObject api = doc.createNestedObject("api");
    api["openSkyClientId"] = openSkyClientId;
    if (redactSecrets)
    {
        api["openSkyClientSecretSet"] = openSkyClientSecret.length() > 0;
        api["aeroApiKeySet"] = aeroApiKey.length() > 0;
    }
    else
    {
        api["openSkyClientSecret"] = openSkyClientSecret;
        api["aeroApiKey"] = aeroApiKey;
    }
    api["positionSource"] = positionSourceToString(positionSource);
    api["serverUrl"] = serverUrl;
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
    track["autoLocateOnBoot"] = autoLocateOnBoot;
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
    lay["showEta"] = layout.showEta;
    lay["flightNumberOverVr"] = layout.flightNumberOverVr;
    lay["noFlightsMode"] = layout.noFlightsMode;

    JsonObject filt = doc.createNestedObject("filters");
    filt["minAltitudeFt"] = filters.minAltitudeFt;
    filt["maxAltitudeFt"] = filters.maxAltitudeFt;
    filt["excludeOnGround"] = filters.excludeOnGround;
    filt["showGeneralAviation"] = filters.showGeneralAviation;
    filt["hideCargo"] = filters.hideCargo;
    JsonArray allow = filt.createNestedArray("airlineAllowList");
    for (const auto &a : filters.airlineAllowList)
        allow.add(a);

    JsonObject sch = doc.createNestedObject("schedule");
    sch["enabled"] = schedule.enabled;
    sch["dayBrightness"] = schedule.dayBrightness;
    sch["nightBrightness"] = schedule.nightBrightness;
    sch["nightStartHour"] = schedule.nightStartHour;
    sch["nightEndHour"] = schedule.nightEndHour;
    sch["timezone"] = schedule.timezone;

    JsonObject btn = doc.createNestedObject("buttons");
    btn["enabled"] = buttonsEnabled;

    JsonObject light = doc.createNestedObject("light");
    light["enabled"] = lightSensorEnabled;
    light["type"] = lightSensorTypeName(lightSensorType);
    light["pin"] = lightSensorPin;
    light["darkThreshold"] = lightDarkThreshold;
    light["hysteresis"] = lightHysteresis;
    light["dimInstead"] = lightSensorDimInstead;
    light["dimBrightness"] = lightDimBrightness;

    JsonObject hw = doc.createNestedObject("hardware");
    hw["panelResX"] = panelResX;
    hw["panelResY"] = panelResY;
    hw["panelChain"] = panelChain;
    hw["panelClkPhase"] = panelClkPhase;
    hw["panelI2sSpeedMhz"] = panelI2sSpeedMhz;
    hw["panelLatchBlanking"] = panelLatchBlanking;
    hw["panelDriverChip"] = panelDriverChip;

    String out;
    serializeJson(doc, out);
    return out;
}

bool Settings::fromJson(const String &in)
{
    JsonDocument doc;
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
        // An EMPTY secret means "unchanged", not "clear it".
        //
        // Since GET no longer returns these, a client cannot echo them back --
        // so an empty string here is a page that had nothing to send, not a
        // deliberate wipe. Without this guard, a browser holding a CACHED older
        // index.html against new firmware would read the (now absent) password,
        // fall back to "", post it, and strand the device in the open setup AP
        // with its credentials gone. That makes the firmware/UI upload order
        // irrelevant instead of load-bearing.
        //
        // Clearing a secret deliberately is still possible over the serial
        // console (`set`), which requires physical possession, and `erase`
        // resets everything.
        if (net.containsKey("wifiPassword") && net["wifiPassword"].as<String>().length())
            wifiPassword = net["wifiPassword"].as<String>();
    }

    if (doc.containsKey("api"))
    {
        JsonObject api = doc["api"];
        if (api.containsKey("openSkyClientId"))
            openSkyClientId = api["openSkyClientId"].as<String>();
        // Same "empty means unchanged" rule as wifiPassword above.
        if (api.containsKey("openSkyClientSecret") && api["openSkyClientSecret"].as<String>().length())
            openSkyClientSecret = api["openSkyClientSecret"].as<String>();
        if (api.containsKey("aeroApiKey") && api["aeroApiKey"].as<String>().length())
            aeroApiKey = api["aeroApiKey"].as<String>();
        if (api.containsKey("positionSource"))
            positionSource = positionSourceFromString(api["positionSource"].as<String>());
        if (api.containsKey("serverUrl"))
        {
            serverUrl = api["serverUrl"].as<String>();
            serverUrl.trim();
            // A trailing slash would produce "...//v1/flights". Normalise once
            // here rather than defensively at the call site.
            while (serverUrl.endsWith("/"))
                serverUrl.remove(serverUrl.length() - 1);
        }
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
        if (track.containsKey("autoLocateOnBoot"))
            autoLocateOnBoot = track["autoLocateOnBoot"].as<bool>();
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
        layout.showEta = lay["showEta"] | layout.showEta;
        layout.flightNumberOverVr = lay["flightNumberOverVr"] | layout.flightNumberOverVr;
        if (lay.containsKey("noFlightsMode"))
            layout.noFlightsMode = lay["noFlightsMode"].as<String>();
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
        if (filt.containsKey("showGeneralAviation"))
            filters.showGeneralAviation = filt["showGeneralAviation"].as<bool>();
        if (filt.containsKey("hideCargo"))
            filters.hideCargo = filt["hideCargo"].as<bool>();
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
        if (sch.containsKey("timezone"))
            schedule.timezone = sch["timezone"].as<const char *>();
    }

    if (doc.containsKey("buttons"))
    {
        JsonObject btn = doc["buttons"];
        if (btn.containsKey("enabled"))
            buttonsEnabled = btn["enabled"].as<bool>();
    }

    if (doc.containsKey("light"))
    {
        JsonObject light = doc["light"];
        if (light.containsKey("enabled"))
            lightSensorEnabled = light["enabled"].as<bool>();
        if (light.containsKey("type"))
            lightSensorType = lightSensorTypeFromName(light["type"].as<const char *>());
        if (light.containsKey("pin"))
            lightSensorPin = light["pin"].as<uint8_t>();
        if (light.containsKey("darkThreshold"))
            lightDarkThreshold = light["darkThreshold"].as<uint16_t>();
        if (light.containsKey("hysteresis"))
            lightHysteresis = light["hysteresis"].as<uint16_t>();
        if (light.containsKey("dimInstead"))
            lightSensorDimInstead = light["dimInstead"].as<bool>();
        if (light.containsKey("dimBrightness"))
            lightDimBrightness = light["dimBrightness"].as<uint8_t>();
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
        if (hw.containsKey("panelClkPhase"))
            panelClkPhase = hw["panelClkPhase"].as<bool>();
        if (hw.containsKey("panelI2sSpeedMhz"))
            panelI2sSpeedMhz = hw["panelI2sSpeedMhz"].as<uint8_t>();
        if (hw.containsKey("panelLatchBlanking"))
            panelLatchBlanking = hw["panelLatchBlanking"].as<uint8_t>();
        if (hw.containsKey("panelDriverChip"))
            panelDriverChip = hw["panelDriverChip"].as<String>();
    }

    return true;
}
