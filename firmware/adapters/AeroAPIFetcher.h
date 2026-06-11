#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "interfaces/BaseFlightFetcher.h"
#include "config/APIConfiguration.h"

class AeroAPIFetcher : public BaseFlightFetcher
{
public:
    AeroAPIFetcher() = default;
    ~AeroAPIFetcher() override = default;

    bool fetchFlightInfo(const String &flightIdent, const String &icao24, FlightInfo &outInfo) override;
};
