/*
Purpose: Implementation of the UART configuration console (see SerialConsole.h).
*/
#include "core/SerialConsole.h"
#include "core/Settings.h"
#include "adapters/LightSensor.h"

#include <WiFi.h>

// First whitespace-delimited token of s; `rest` gets the trimmed remainder.
static String firstToken(const String &s, String &rest)
{
    String t = s;
    t.trim();
    int sp = t.indexOf(' ');
    if (sp < 0)
    {
        rest = "";
        return t;
    }
    String head = t.substring(0, sp);
    rest = t.substring(sp + 1);
    rest.trim();
    return head;
}

void SerialConsole::begin()
{
    Serial.println();
    Serial.println("FlightWall serial console ready. Type 'help' for commands.");
}

// `light` / `light watch`. Prints the reading in the SELECTED SENSOR'S units and
// spells out the hysteresis arithmetic, because the threshold's meaning changes with
// the sensor type (raw ADC 0-4095 / lux / raw Clear) and no single default can suit
// all three — the numbers below are the only honest way to pick one.
void SerialConsole::printLight(bool oneShot)
{
    if (!g_settings.lightSensorEnabled)
    {
        if (oneShot)
            Serial.println(F("[light] sensor disabled (enable it in the web UI or via 'set')"));
        return;
    }
    if (!_light)
    {
        if (oneShot)
            Serial.println(F("[light] no sensor wired to the console"));
        return;
    }

    const char *type = g_settings.lightSensorType == LightSensorType::BH1750    ? "bh1750 (lux)"
                       : g_settings.lightSensorType == LightSensorType::TCS3472 ? "tcs3472 (raw Clear)"
                                                                                : "analog (raw ADC 0-4095)";
    const int lvl = _light->level();
    const unsigned thr = g_settings.lightDarkThreshold;
    const unsigned lit = thr + g_settings.lightHysteresis;

    if (lvl < 0)
    {
        Serial.printf("[light] %s: NO READING (sensor absent/failed) -> reporting 'lit' (fail-safe)\n",
                      type);
        return;
    }
    if (oneShot)
        Serial.printf("[light] %s\n  reading   : %d\n  state     : %s\n"
                      "  goes dark : reading < %u\n  goes lit  : reading > %u  (threshold %u + hysteresis %u)\n"
                      "  panel     : %s when dark\n",
                      type, lvl, _light->isDark() ? "DARK" : "lit", thr, lit, thr,
                      (unsigned)g_settings.lightHysteresis,
                      g_settings.lightSensorDimInstead ? "dimmed" : "blanked");
    else
        Serial.printf("[light] %d  %s   (dark<%u, lit>%u)\n", lvl, _light->isDark() ? "DARK" : "lit", thr, lit);
}

void SerialConsole::poll()
{
    if (_watchLight && millis() - _lastWatchMs >= 1000)
    {
        _lastWatchMs = millis();
        printLight(false);
    }

    while (Serial.available() > 0)
    {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r')
        {
            if (_buf.length() > 0)
            {
                handleLine(_buf);
                _buf = "";
            }
        }
        else if (_buf.length() < 512)
        {
            _buf += c;
        }
    }
}

void SerialConsole::printHelp()
{
    Serial.println(F(
        "Commands:\n"
        "  help                          this help\n"
        "  status                        connection + settings summary\n"
        "  wifi <ssid> <password>        set WiFi (then 'restart')\n"
        "  opensky <id> <secret>         set OpenSky credentials\n"
        "  aeroapi <key>                 set AeroAPI key\n"
        "  enrich <adsbdb|aeroapi|off>   set enrichment source\n"
        "  mode <area|flights>           set tracking mode\n"
        "  loc <lat> <lon> <radiusKm>    set Area-mode location\n"
        "  light [watch]                 ambient reading; 'watch' streams at 1Hz\n"
        "  get                           print settings JSON\n"
        "  set <json>                    apply a settings JSON document\n"
        "  save                          persist settings\n"
        "  erase                         reset to defaults\n"
        "  restart                       reboot"));
}

void SerialConsole::printStatus()
{
    bool ap = (WiFi.getMode() & WIFI_AP) && !(WiFi.status() == WL_CONNECTED);
    Serial.print(F("WiFi: "));
    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.print(F("connected to '"));
        Serial.print(WiFi.SSID());
        Serial.print(F("'  IP "));
        Serial.println(WiFi.localIP());
    }
    else if (ap)
    {
        Serial.print(F("setup AP  IP "));
        Serial.println(WiFi.softAPIP());
    }
    else
    {
        Serial.println(F("not connected"));
    }
    Serial.print(F("SSID set: "));
    Serial.println(g_settings.wifiSsid.length() ? g_settings.wifiSsid : String("(none)"));
    Serial.print(F("Mode: "));
    Serial.println(g_settings.mode == TrackingMode::Flights ? F("flights") : F("area"));
    Serial.print(F("Enrichment: "));
    Serial.println(g_settings.enrichmentSource == EnrichmentSource::AeroApi ? F("aeroapi")
                   : g_settings.enrichmentSource == EnrichmentSource::Off   ? F("off")
                                                                            : F("adsbdb"));
    Serial.print(F("Location: "));
    Serial.print(g_settings.centerLat, 4);
    Serial.print(F(", "));
    Serial.print(g_settings.centerLon, 4);
    Serial.print(F("  r="));
    Serial.print(g_settings.radiusKm, 1);
    Serial.println(F("km"));
}

void SerialConsole::handleLine(String line)
{
    line.trim();
    if (line.length() == 0)
        return;

    String args;
    String cmd = firstToken(line, args);
    cmd.toLowerCase();

    if (cmd == "help" || cmd == "?")
    {
        printHelp();
    }
    else if (cmd == "status")
    {
        printStatus();
    }
    else if (cmd == "wifi")
    {
        String pw;
        String ssid = firstToken(args, pw);
        if (ssid.length() == 0)
        {
            Serial.println(F("usage: wifi <ssid> <password>"));
            return;
        }
        g_settings.wifiSsid = ssid;
        g_settings.wifiPassword = pw; // may be empty for open networks
        g_settings.save();
        Serial.print(F("WiFi saved (ssid='"));
        Serial.print(ssid);
        Serial.println(F("'). Type 'restart' to connect."));
    }
    else if (cmd == "opensky")
    {
        String secret;
        String id = firstToken(args, secret);
        if (id.length() == 0 || secret.length() == 0)
        {
            Serial.println(F("usage: opensky <id> <secret>"));
            return;
        }
        g_settings.openSkyClientId = id;
        g_settings.openSkyClientSecret = secret;
        g_settings.save();
        Serial.println(F("OpenSky credentials saved."));
    }
    else if (cmd == "aeroapi")
    {
        if (args.length() == 0)
        {
            Serial.println(F("usage: aeroapi <key>"));
            return;
        }
        g_settings.aeroApiKey = args;
        g_settings.save();
        Serial.println(F("AeroAPI key saved."));
    }
    else if (cmd == "enrich")
    {
        args.toLowerCase();
        if (args == "aeroapi")
            g_settings.enrichmentSource = EnrichmentSource::AeroApi;
        else if (args == "off")
            g_settings.enrichmentSource = EnrichmentSource::Off;
        else if (args == "adsbdb")
            g_settings.enrichmentSource = EnrichmentSource::Adsbdb;
        else
        {
            Serial.println(F("usage: enrich <adsbdb|aeroapi|off>"));
            return;
        }
        g_settings.save();
        Serial.println(F("Enrichment source saved."));
    }
    else if (cmd == "mode")
    {
        args.toLowerCase();
        if (args == "area")
            g_settings.mode = TrackingMode::Area;
        else if (args == "flights")
            g_settings.mode = TrackingMode::Flights;
        else
        {
            Serial.println(F("usage: mode <area|flights>"));
            return;
        }
        g_settings.save();
        Serial.println(F("Mode saved."));
    }
    else if (cmd == "loc")
    {
        String rest1, rest2;
        String latS = firstToken(args, rest1);
        String lonS = firstToken(rest1, rest2);
        String radS = rest2;
        radS.trim();
        if (latS.length() == 0 || lonS.length() == 0 || radS.length() == 0)
        {
            Serial.println(F("usage: loc <lat> <lon> <radiusKm>"));
            return;
        }
        g_settings.centerLat = latS.toDouble();
        g_settings.centerLon = lonS.toDouble();
        g_settings.radiusKm = radS.toDouble();
        g_settings.save();
        Serial.println(F("Location saved."));
    }
    else if (cmd == "get")
    {
        Serial.println(g_settings.toJson());
    }
    else if (cmd == "set")
    {
        if (args.length() == 0)
        {
            Serial.println(F("usage: set <json>"));
            return;
        }
        if (g_settings.fromJson(args))
        {
            g_settings.save();
            Serial.println(F("Settings applied + saved."));
        }
        else
        {
            Serial.println(F("Invalid JSON."));
        }
    }
    else if (cmd == "light")
    {
        args.trim();
        args.toLowerCase();
        if (args == "watch")
        {
            _watchLight = !_watchLight;
            _lastWatchMs = 0; // print immediately rather than after the first second
            Serial.println(_watchLight ? F("Watching light (type 'light watch' to stop).")
                                       : F("Stopped watching light."));
        }
        else if (args.length() == 0)
        {
            printLight(true);
        }
        else
        {
            Serial.println(F("usage: light [watch]"));
        }
    }
    else if (cmd == "save")
    {
        Serial.println(g_settings.save() ? F("Saved.") : F("Save failed."));
    }
    else if (cmd == "erase")
    {
        g_settings.seedDefaults();
        g_settings.save();
        Serial.println(F("Settings reset to defaults. Type 'restart'."));
    }
    else if (cmd == "restart")
    {
        Serial.println(F("Restarting..."));
        delay(150);
        ESP.restart();
    }
    else
    {
        Serial.print(F("Unknown command: "));
        Serial.println(cmd);
        Serial.println(F("Type 'help'."));
    }
}
