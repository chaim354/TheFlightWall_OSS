#pragma once

#include <Arduino.h>
#include <vector>
#include "interfaces/BaseStateVectorFetcher.h"
#include "interfaces/BaseFlightFetcher.h"
#include "models/StateVector.h"
#include "models/FlightInfo.h"

class FlightDataFetcher
{
public:
    FlightDataFetcher(BaseStateVectorFetcher *stateFetcher,
                      BaseFlightFetcher *flightFetcher);

    // Fetches according to the current tracking mode in g_settings, applies
    // filters, caps to maxFlights, and enriches with friendly names + metrics.
    size_t fetchFlights(std::vector<StateVector> &outStates,
                        std::vector<FlightInfo> &outFlights);

private:
    BaseStateVectorFetcher *_stateFetcher;
    BaseFlightFetcher *_flightFetcher;

    size_t fetchAreaMode(std::vector<StateVector> &outStates,
                         std::vector<FlightInfo> &outFlights);
    size_t fetchFlightsMode(std::vector<FlightInfo> &outFlights);

    void enrichNames(FlightInfo &info);
    bool passesAirlineAllowList(const FlightInfo &info);
};
