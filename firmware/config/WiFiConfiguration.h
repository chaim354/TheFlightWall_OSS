#pragma once

#include <Arduino.h>

// Optionally pull WiFi/API credentials from a gitignored config/Secrets.h so you
// can bake them in at flash time without committing them. Copy Secrets.h.example
// to Secrets.h and fill it in. If absent, values default to empty and the device
// starts its "FlightWall-Setup" WiFi access point for browser-based setup.
#if defined(__has_include)
#  if __has_include("Secrets.h")
#    include "Secrets.h"
#  endif
#endif

#ifndef FW_WIFI_SSID
#  define FW_WIFI_SSID ""
#endif
#ifndef FW_WIFI_PASSWORD
#  define FW_WIFI_PASSWORD ""
#endif

namespace WiFiConfiguration
{
    static const char *WIFI_SSID = FW_WIFI_SSID;
    static const char *WIFI_PASSWORD = FW_WIFI_PASSWORD;
}
