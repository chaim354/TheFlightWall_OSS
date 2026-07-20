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

private:
    String _buf;
    const LightSensor *_light = nullptr;
    bool _watchLight = false;
    unsigned long _lastWatchMs = 0;

    void handleLine(String line);
    void printHelp();
    void printStatus();
    void printLight(bool oneShot);
};
