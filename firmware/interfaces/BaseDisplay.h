#pragma once

#include <stdint.h>
#include <vector>
#include "models/FlightInfo.h"

class BaseDisplay
{
public:
    virtual ~BaseDisplay() = default;
    virtual bool initialize() = 0;
    virtual void clear() = 0;
    virtual void displayFlights(const std::vector<FlightInfo> &flights) = 0;
};
