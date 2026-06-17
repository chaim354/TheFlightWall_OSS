#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "interfaces/BaseStateVectorFetcher.h"
#include "utils/GeoUtils.h"
#include "config/APIConfiguration.h"
#include "config/UserConfiguration.h"
#include "core/HttpJson.h"

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

    void setHttp(HttpJson *http) { _http = http; }

private:
    HttpJson *_http = nullptr;
    String m_accessToken;
    unsigned long m_tokenExpiryMs = 0;

    bool ensureAccessToken(bool forceRefresh = false);
    bool requestAccessToken(String &outToken, unsigned long &outExpiryMs);

    // Parses the states/all body one aircraft at a time (bounded memory — never
    // builds a document of the whole response), filtering by radius and capping count.
    void parseStatesInto(Stream &stream, double centerLat, double centerLon,
                         double radiusKm, std::vector<StateVector> &out);
};
