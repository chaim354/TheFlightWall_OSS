#pragma once

#include <Arduino.h>

struct AirportInfo
{
    String code_icao;
    String code_iata; // preferred for display (e.g. "ORD" vs "KORD")
};
