#pragma once
/*
Purpose: ICAO airline code -> human-readable display name, resolved entirely on device.

Why this exists: the position feed identifies an operator by ICAO code only. Under
OpenSky the name arrives from adsbdb enrichment, but Flightradar24 supplies route and
aircraft inline and so skips that lookup entirely — leaving the panel and the web list
rendering "DAL" where they used to say "Delta". Resolving locally fixes both surfaces
for every flight in the same cycle, with no network call, no enrichment budget spent,
no blocking of the single-threaded loop() that also serves the web UI, and no exposure
to a rate limit.

Cost: the table is const, so it lives in memory-mapped flash rather than the heap —
zero RAM. At ~30 bytes an entry this is a few KB against ~1.9MB of free app partition.

Lookup is LINEAR, deliberately. A sorted array with a binary search would be faster,
but it silently returns wrong answers the first time someone adds an entry out of
order, and this is edited by hand. At a few hundred entries times maxFlights lookups
once per fetch cycle the cost is irrelevant; the failure mode is not.

Names are ASCII only — the panel font has no accented glyphs ("Aeromexico", not
"Aerom\u00e9xico"). Keep them short: Hub75Display truncates to the panel width, and
stripAirlineWords() drops trailing "Airlines"/"Airways" so the logo need not repeat it.
*/

#include <Arduino.h>
#include <string.h>

struct AirlineName
{
    const char *icao;
    const char *name;
};

static const AirlineName kAirlineNames[] = {
    {"AAL", "American Airlines"},
    {"AAR", "Asiana Airlines"},
    {"AAY", "Allegiant Air"},
    {"ABL", "Air Busan"},
    {"ABW", "AirBridgeCargo"},
    {"ABX", "ABX Air"},
    {"ABY", "Air Arabia"},
    {"ACA", "Air Canada"},
    {"AEA", "Air Europa"},
    {"AEE", "Aegean Airlines"},
    {"AFL", "Aeroflot"},
    {"AFR", "Air France"},
    {"AHY", "Azerbaijan Airlines"},
    {"AIC", "Air India"},
    {"AIQ", "Thai AirAsia"},
    {"AJA", "AnadoluJet"},
    {"AMX", "Aeromexico"},
    {"ANA", "All Nippon Airways"},
    {"ANE", "Air Nostrum"},
    {"ANZ", "Air New Zealand"},
    {"APJ", "Peach Aviation"},
    {"ARG", "Aerolineas Argentinas"},
    {"ASA", "Alaska Airlines"},
    {"ASH", "Mesa Airlines"},
    {"ASQ", "ExpressJet"},
    {"AUA", "Austrian Airlines"},
    {"AVA", "Avianca"},
    {"AWI", "Air Wisconsin"},
    {"AXM", "AirAsia"},
    {"AZA", "Alitalia"},
    {"AZU", "Azul"},
    {"BAW", "British Airways"},
    {"BEL", "Brussels Airlines"},
    {"BOX", "AeroLogic"},
    {"BTI", "Air Baltic"},
    {"BWA", "Caribbean Airlines"},
    {"CAI", "Corendon"},
    {"CAL", "China Airlines"},
    {"CAO", "Air China Cargo"},
    {"CCA", "Air China"},
    {"CEB", "Cebu Pacific"},
    {"CES", "China Eastern"},
    {"CFG", "Condor"},
    {"CHH", "Hainan Airlines"},
    {"CJT", "Cargojet"},
    {"CKK", "China Cargo"},
    {"CKS", "Kalitta Air"},
    {"CLX", "Cargolux"},
    {"CMP", "Copa Airlines"},
    {"CPA", "Cathay Pacific"},
    {"CPZ", "Compass Airlines"},
    {"CQH", "Spring Airlines"},
    {"CSA", "Czech Airlines"},
    {"CSN", "China Southern"},
    {"CSZ", "Shenzhen Airlines"},
    {"CXA", "Xiamen Airlines"},
    {"DAH", "Air Algerie"},
    {"DAL", "Delta Air Lines"},
    {"DHK", "DHL Air"},
    {"DLH", "Lufthansa"},
    {"EDV", "Endeavor Air"},
    {"EIN", "Aer Lingus"},
    {"EJA", "NetJets"},
    {"EJM", "Executive Jet Mgmt"},
    {"EJU", "easyJet Europe"},
    {"ELY", "El Al"},
    {"ENY", "Envoy Air"},
    {"ETD", "Etihad Airways"},
    {"ETH", "Ethiopian Airlines"},
    {"EVA", "EVA Air"},
    {"EWG", "Eurowings"},
    {"EXS", "Jet2"},
    {"EZS", "easyJet Switzerland"},
    {"EZY", "easyJet"},
    {"FDB", "flydubai"},
    {"FDX", "FedEx Express"},
    {"FFT", "Frontier Airlines"},
    {"FIN", "Finnair"},
    {"FLE", "Flair Airlines"},
    {"GEC", "Lufthansa Cargo"},
    {"GFA", "Gulf Air"},
    {"GIA", "Garuda Indonesia"},
    {"GJS", "GoJet Airlines"},
    {"GLO", "Gol"},
    {"GSS", "Global Supply Systems"},
    {"GTI", "Atlas Air"},
    {"HAL", "Hawaiian Airlines"},
    {"HVN", "Vietnam Airlines"},
    {"IBE", "Iberia"},
    {"IBS", "Iberia Express"},
    {"ICE", "Icelandair"},
    {"IGO", "IndiGo"},
    {"ITY", "ITA Airways"},
    {"JAF", "TUI fly Belgium"},
    {"JAL", "Japan Airlines"},
    {"JBU", "JetBlue Airways"},
    {"JIA", "PSA Airlines"},
    {"JJP", "Jetstar Japan"},
    {"JNA", "Jin Air"},
    {"JST", "Jetstar"},
    {"JSX", "JSX"},
    {"JZA", "Jazz Aviation"},
    {"KAC", "Kuwait Airways"},
    {"KAL", "Korean Air"},
    {"KLM", "KLM"},
    {"KNE", "flynas"},
    {"KQA", "Kenya Airways"},
    {"KZR", "Air Astana"},
    {"LAN", "LATAM"},
    {"LNI", "Lion Air"},
    {"LOT", "LOT Polish Airlines"},
    {"LXJ", "Flexjet"},
    {"MAS", "Malaysia Airlines"},
    {"MPH", "Martinair"},
    {"MSR", "EgyptAir"},
    {"MXY", "Breeze Airways"},
    {"NAX", "Norwegian"},
    {"NBT", "Norse Atlantic"},
    {"NCA", "Nippon Cargo"},
    {"NKS", "Spirit Airlines"},
    {"OAL", "Olympic Air"},
    {"OMA", "Oman Air"},
    {"PAC", "Polar Air Cargo"},
    {"PAL", "Philippine Airlines"},
    {"PDT", "Piedmont Airlines"},
    {"PGT", "Pegasus Airlines"},
    {"POE", "Porter Airlines"},
    {"QFA", "Qantas"},
    {"QTR", "Qatar Airways"},
    {"QXE", "Horizon Air"},
    {"RAM", "Royal Air Maroc"},
    {"RJA", "Royal Jordanian"},
    {"ROU", "Air Canada Rouge"},
    {"RPA", "Republic Airways"},
    {"RUK", "Ryanair UK"},
    {"RYR", "Ryanair"},
    {"SAA", "South African Airways"},
    {"SAS", "SAS"},
    {"SBI", "S7 Airlines"},
    {"SCX", "Sun Country Airlines"},
    {"SEJ", "SpiceJet"},
    {"SIA", "Singapore Airlines"},
    {"SKW", "SkyWest"},
    {"SKY", "Skymark"},
    {"SQC", "Singapore Air Cargo"},
    {"SVA", "Saudia"},
    {"SWA", "Southwest Airlines"},
    {"SWG", "Sunwing"},
    {"SWR", "Swiss"},
    {"SXS", "SunExpress"},
    {"TAM", "LATAM Brasil"},
    {"TAP", "TAP Air Portugal"},
    {"TAR", "Tunisair"},
    {"TGW", "Scoot"},
    {"THA", "Thai Airways"},
    {"THY", "Turkish Airlines"},
    {"TOM", "TUI Airways"},
    {"TRA", "Transavia"},
    {"TSC", "Air Transat"},
    {"TUI", "TUI fly"},
    {"TWB", "T'way Air"},
    {"UAE", "Emirates"},
    {"UAL", "United Airlines"},
    {"UCA", "CommutAir"},
    {"UPS", "UPS Airlines"},
    {"UZB", "Uzbekistan Airways"},
    {"VIR", "Virgin Atlantic"},
    {"VIV", "Viva Aerobus"},
    {"VJC", "VietJet Air"},
    {"VKG", "Sunclass Airlines"},
    {"VLG", "Vueling"},
    {"VOE", "Volotea"},
    {"VOI", "Volaris"},
    {"VOZ", "Virgin Australia"},
    {"VTI", "Vistara"},
    {"WJA", "WestJet"},
    {"WZZ", "Wizz Air"},
};

// Returns nullptr when the code is unknown, which callers must treat as "keep showing
// the ICAO code" rather than as an error — an unlisted operator is expected, not a bug.
inline const char *airlineNameForIcao(const char *icao)
{
    if (!icao || !icao[0])
        return nullptr;
    for (size_t i = 0; i < sizeof(kAirlineNames) / sizeof(kAirlineNames[0]); ++i)
    {
        if (strcasecmp(icao, kAirlineNames[i].icao) == 0)
            return kAirlineNames[i].name;
    }
    return nullptr;
}
