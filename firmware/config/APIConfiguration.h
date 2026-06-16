#pragma once

#include <Arduino.h>

// Optional compile-time credentials from a gitignored config/Secrets.h (see
// Secrets.h.example). These seed the device on first boot; afterwards everything
// is managed from the web UI. If Secrets.h is absent, values default to empty.
#if defined(__has_include)
#  if __has_include("Secrets.h")
#    include "Secrets.h"
#  endif
#endif

#ifndef FW_OPENSKY_CLIENT_ID
#  define FW_OPENSKY_CLIENT_ID ""
#endif
#ifndef FW_OPENSKY_CLIENT_SECRET
#  define FW_OPENSKY_CLIENT_SECRET ""
#endif
#ifndef FW_AEROAPI_KEY
#  define FW_AEROAPI_KEY ""
#endif

namespace APIConfiguration
{
    // OpenSky API credentials
    static const char *OPENSKY_CLIENT_ID = FW_OPENSKY_CLIENT_ID;
    static const char *OPENSKY_CLIENT_SECRET = FW_OPENSKY_CLIENT_SECRET;
    static constexpr const char *OPENSKY_TOKEN_URL =
        "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

    static constexpr const char *OPENSKY_BASE_URL = "https://opensky-network.org";

    // FlightAware AeroAPI credentials
    static const char *AEROAPI_KEY = FW_AEROAPI_KEY;
    static constexpr const char *AEROAPI_BASE_URL = "https://aeroapi.flightaware.com/aeroapi";

    // FlightWall CDN lookup
    static constexpr const char *FLIGHTWALL_CDN_BASE_URL = "https://cdn.theflightwall.com";

    // TLS behavior for external services
    static const bool AEROAPI_INSECURE_TLS = true;
    static const bool FLIGHTWALL_INSECURE_TLS = true;
}
