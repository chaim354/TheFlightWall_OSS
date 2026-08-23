#pragma once

#include <Arduino.h>

struct AirportInfo
{
    String code_icao;
    String code_iata;

    /**
     * The code to show. IATA when we have it, ICAO otherwise.
     *
     * This used to be a comment ("preferred for display") that three consumers
     * re-implemented independently, and one of them got it wrong:
     * Hub75Display::buildFlightLines read code_icao ALONE. Producers make that
     * fatal rather than merely inconsistent -- FlightWallServerFetcher and the
     * Flightradar24 inline path both set code_iata and NEVER code_icao, because
     * neither wire format carries ICAO at all. So on those sources both strings
     * were empty, `origin.length() || dest.length()` was false, and the route
     * line was silently dropped from the card.
     *
     * WebConfigServer carries a comment recording that this exact bug was found
     * and fixed once -- in the web list. The panel copy was never fixed. Hence a
     * method rather than a fourth copy of the ternary: it is the rule the header
     * already asserted, relocated to the one place all readers pass through.
     */
    String displayCode() const { return code_iata.length() ? code_iata : code_icao; }
};
