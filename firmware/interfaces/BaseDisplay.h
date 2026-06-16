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

    // Read-only access to the current frame (RGB565, row-major) for the web
    // preview. Default: no framebuffer available.
    virtual const uint16_t *framebuffer(uint16_t &w, uint16_t &h) const
    {
        w = 0;
        h = 0;
        return nullptr;
    }
};
