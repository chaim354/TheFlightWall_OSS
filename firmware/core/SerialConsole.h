/*
Purpose: Tiny serial command console for configuring the device over UART after
flashing (no recompile, no setup AP needed). Open the serial monitor at 115200
and type commands; changes are written to the persisted Settings.

Commands:
  help                          show this help
  status                        connection + current settings summary
  wifi <ssid> <password>        set WiFi (password may contain spaces)
  opensky <id> <secret>         set OpenSky OAuth credentials
  aeroapi <key>                 set FlightAware AeroAPI key
  enrich <adsbdb|aeroapi|off>   set flight-enrichment source
  mode <area|flights>           set tracking mode
  loc <lat> <lon> <radiusKm>    set Area-mode location
  light                         print one ambient-light reading + threshold maths
  light watch                   stream the reading at 1Hz (repeat to stop)
  get                           print full settings JSON
  set <json>                    apply a settings JSON document (partial ok)
  save                          persist settings
  erase                         reset to defaults
  restart                       reboot the device
*/
#pragma once

#include <Arduino.h>

class LightSensor; // only held by pointer here; included in the .cpp

class SerialConsole
{
public:
    void begin();
    void poll(); // call frequently from loop()

    // Read-only view of the live sensor, for the `light` command. The web UI's
    // /api/status is the other readout, but it is unusable for tuning while a fetch
    // is in flight: loop() blocks on the network, so both the HTTP response AND the
    // 500ms sampling stall, and the reading aliases. Serial has no such dependency.
    void setLightSensor(const LightSensor *light) { _light = light; }

    // One-shot "I changed g_settings" signal, drained by loop().
    //
    // The same flag WebConfigServer has, and for the same reason -- this is not
    // a new concept, it is the one the console was missing. It was the ONLY
    // writer to g_settings that neither re-applied its own changes nor told
    // anyone, so four groups of latched state (schedule.timezone, which lives in
    // libc's environment; light enable/type/pin; buttons.enabled; and
    // display.maxFlights, which sizes the logo pool) simply never took effect
    // until the next reboot. The console even printed "Settings applied +
    // saved." while "applied" was false for all four -- and told users to enable
    // the light sensor "via 'set'", after which its own `light` command reported
    // NO READING on correctly wired hardware.
    bool consumeSettingsChanged();

private:
    String _buf;
    bool _settingsChanged = false;
    const LightSensor *_light = nullptr;
    bool _watchLight = false;
    unsigned long _lastWatchMs = 0;

    void handleLine(String line);
    void printHelp();
    void printStatus();
    void printLight(bool oneShot);
};
