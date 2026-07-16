#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "interfaces/BaseStateVectorFetcher.h"
#include "utils/GeoUtils.h"
#include "config/APIConfiguration.h"
#include "config/UserConfiguration.h"

class OpenSkyFetcher : public BaseStateVectorFetcher
{
public:
    OpenSkyFetcher() = default;
    ~OpenSkyFetcher() override = default;

    bool fetchStateVectors(double centerLat,
                           double centerLon,
                           double radiusKm,
                           std::vector<StateVector> &outStateVectors) override;

    bool ensureAuthenticated(bool forceRefresh = false);

private:
    String m_accessToken;
    unsigned long m_tokenExpiryMs = 0;

    // Our own TLS client, so the handshake can be BOUNDED. HTTPClient::begin(url)
    // builds its own WiFiClientSecure internally (via TLSTraits) that we cannot
    // reach — and its handshake_timeout then defaults to 120000ms, exactly the loop
    // watchdog's 120s. A stalled handshake therefore panics the device before
    // ssl_client's own bail-out can fire: the escape hatch is set to the deadline it
    // is supposed to beat. Confirmed by coredump — loopTask parked at
    // ssl_client.cpp:277 (vTaskDelay in the mbedtls_ssl_handshake retry loop) with
    // this exact call stack. HttpJson already defends this way; OpenSky did not.
    WiFiClientSecure m_secure;
    bool m_secureInit = false;
    WiFiClientSecure &secureClient(); // lazily applies setInsecure + handshake bound

    bool ensureAccessToken(bool forceRefresh = false);
    bool requestAccessToken(String &outToken, unsigned long &outExpiryMs);

    // Parses the states/all body one aircraft at a time (bounded memory — never
    // builds a document of the whole response), filtering by radius and capping count.
    void parseStatesInto(Stream &stream, double centerLat, double centerLon,
                         double radiusKm, std::vector<StateVector> &out);
};
