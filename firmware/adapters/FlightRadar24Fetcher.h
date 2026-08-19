#pragma once
/*
Purpose: OPT-IN, no-key position source backed by Flightradar24's INTERNAL web
feed (the same JSON fr24.com's live map fetches). Unlike OpenSky, one bounding-box
call to feed.js returns position AND route AND aircraft type AND airline together,
so this fills the inline-enrichment fields on StateVector and the Area-mode path can
skip the per-flight adsbdb/hexdb lookups entirely. The one thing the feed does not carry
is a readable airline NAME — it gives the operator as an ICAO code — so that is resolved
on device from utils/AirlineNames.h.

  !!  This is an UNOFFICIAL scrape, not an API.  !!
  - It violates Flightradar24's Terms of Service (personal/educational use only;
    business@fr24.com for commercial). It is therefore gated behind
    PositionSource::FlightRadar24 and is NEVER the default. OpenSky stays default.
  - The endpoint is undocumented and changes without notice; FR24 also rate-limits
    and IP-bans aggressive scrapers. Keep the radius tight and the cadence gentle
    (the existing 30s FETCH_INTERVAL_SECONDS is fine). Expect to patch this when it
    breaks — the stable sources (OpenSky/adsbdb/hexdb) do not have that liability.

Mirrors OpenSkyFetcher's transport discipline: its own WiFiClientSecure with a
BOUNDED handshake, so a stalled TLS negotiation fails fast instead of tripping the
120s loop watchdog. See OpenSkyFetcher::secureClient() for the full rationale.
*/

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "interfaces/BaseStateVectorFetcher.h"

class FlightRadar24Fetcher : public BaseStateVectorFetcher
{
public:
    FlightRadar24Fetcher() = default;
    ~FlightRadar24Fetcher() override = default;

    bool fetchStateVectors(double centerLat,
                           double centerLon,
                           double radiusKm,
                           std::vector<StateVector> &outStateVectors) override;

private:
    // Own TLS client with a bounded handshake (see OpenSkyFetcher for why this is
    // load-bearing against the loop watchdog, not a nicety).
    WiFiClientSecure m_secure;
    bool m_secureInit = false;
    WiFiClientSecure &secureClient();

    // Parse feed.js (a JSON object keyed by opaque FR24 flight id) into state
    // vectors, filtering to the circular radius. Throws nothing; on OOM it simply
    // returns what it managed to collect.
    void parseFeedInto(JsonDocument &doc, double centerLat, double centerLon,
                       double radiusKm, std::vector<StateVector> &out);
};
