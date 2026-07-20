#pragma once

#include <stddef.h>

// Short, factual aviation tidbits shown on the "no flights" screen when
// noFlightsMode is "funfact" or "clockfact". Kept brief so they word-wrap into
// ~3-4 lines at the panel's character width. Non-trademark, general-knowledge.
static const char *const kFunFacts[] = {
    "The black box is actually bright orange.",
    "A 777 wingtip can flex up to 26 feet.",
    "Cabin air is refreshed every 2-3 minutes.",
    "Contrails are just frozen water vapor.",
    "Most jets can fly fine on a single engine.",
    "Runway numbers come from compass headings.",
    "Squawk 7700 means in-flight emergency.",
    "Winglets curve up to cut drag and save fuel.",
    "A jumbo jet burns ~1 gallon of fuel per second.",
    "Cruise altitude air is about -57C outside.",
    "Lightning hits planes yearly, almost always harmlessly.",
    "The A380 can carry over 850 passengers.",
    "KLM has flown under its own name since 1919.",
    "Jet fuel is a refined kind of kerosene.",
    "747 tires are inflated to about 200 psi.",
    "ADS-B lets anyone track planes by radio.",
    "Pilots and copilots eat different meals.",
    "Most airliners cruise around 35,000 feet.",
    "The Concorde cruised at twice the speed of sound.",
    "A 747 is made of ~6 million parts.",
    "Black boxes survive about 3,400 G of impact.",
    "The shortest airline flight lasts under 2 minutes.",
    "Transatlantic nonstop was first flown in 1919.",
    "Vapor over the wings is just low-pressure condensation.",
};

static const size_t kFunFactCount = sizeof(kFunFacts) / sizeof(kFunFacts[0]);
