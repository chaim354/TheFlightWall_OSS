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
  get                           print full settings JSON
  set <json>                    apply a settings JSON document (partial ok)
  save                          persist settings
  erase                         reset to defaults
  restart                       reboot the device
*/
#pragma once

#include <Arduino.h>

class SerialConsole
{
public:
    void begin();
    void poll(); // call frequently from loop()

private:
    String _buf;
    void handleLine(String line);
    void printHelp();
    void printStatus();
};
