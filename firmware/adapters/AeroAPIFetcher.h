#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include "interfaces/BaseFlightFetcher.h"
#include "config/APIConfiguration.h"
#include "core/HttpJson.h"

class AeroAPIFetcher : public BaseFlightFetcher
{
public:
    AeroAPIFetcher() = default;
    ~AeroAPIFetcher() override = default;

    void setHttp(HttpJson *http) { _http = http; }

    bool fetchFlightInfo(const String &flightIdent, const String &icao24, FlightInfo &outInfo) override;

private:
    HttpJson *_http = nullptr;
};
