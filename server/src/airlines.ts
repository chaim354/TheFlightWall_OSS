/**
 * Marketing carrier IATA -> display name.
 *
 * Keyed by the MARKETING carrier from the schedule row, not by the ADS-B
 * callsign prefix. That distinction is the whole point: a callsign-prefix table
 * renders EDV5075 as "Endeavor Air" when the flight is sold as Delta, and it
 * structurally cannot do better, because RPA flies for American and Delta both.
 *
 * Names are deliberately short — the panel is 64px wide.
 *
 * Unknown codes return null, and callers must PASS THAT NULL ON rather than
 * substituting the bare code. enrich.ts used to substitute, and it cost us:
 * the wall reads any non-empty name as authoritative, so "SV" pre-empted the
 * "Saudia" its own utils/AirlineNames.h had all along. This table is 44
 * marketing carriers; the device's is 177 operating ones. Null is what lets
 * the better-stocked table answer -- and if it cannot, the device shows the
 * operator code, so the honest bare code is still where the chain ends.
 */
const NAMES: Readonly<Record<string, string>> = {
  AA: 'American', DL: 'Delta', UA: 'United', B6: 'JetBlue', WN: 'Southwest',
  AS: 'Alaska', NK: 'Spirit', F9: 'Frontier', HA: 'Hawaiian', G4: 'Allegiant',
  AC: 'Air Canada', BA: 'British Airways', VS: 'Virgin Atlantic',
  LH: 'Lufthansa', AF: 'Air France', KL: 'KLM', IB: 'Iberia', EI: 'Aer Lingus',
  EK: 'Emirates', QR: 'Qatar', EY: 'Etihad', TK: 'Turkish', SQ: 'Singapore',
  NH: 'ANA', JL: 'JAL', QF: 'Qantas', AM: 'Aeromexico', AV: 'Avianca',
  LA: 'LATAM', CM: 'Copa', TP: 'TAP', SK: 'SAS', AY: 'Finnair', LX: 'SWISS',
  OS: 'Austrian', SN: 'Brussels', AZ: 'ITA', VY: 'Vueling', FR: 'Ryanair',
  U2: 'easyJet', WS: 'WestJet', PD: 'Porter', FX: 'FedEx', '5X': 'UPS',
};

export function airlineName(carrierIata: string): string | null {
  return NAMES[carrierIata.trim().toUpperCase()] ?? null;
}
