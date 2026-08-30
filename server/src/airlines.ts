import { CARRIER_NAMES } from './airlines.data';
import { DEVICE_CARRIER_NAMES } from './airlines.device';

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
 * "Saudia" its own utils/AirlineNames.h had all along.
 *
 * THIS TABLE IS NO LONGER THE ONLY ONE HERE, and the reasoning above changed
 * with that. It used to say that null "lets the better-stocked table answer"
 * -- meaning the firmware's, over on the device. The server now carries that
 * table too (./airlines.device.ts, generated from the very same header) plus a
 * 2,178-carrier dataset (./airlines.data.ts), so airlineName() below answers
 * from all three in precedence order and null means genuinely nobody knows.
 * The device's copy remains its offline fallback, and the bare operator code
 * is still where the chain ends.
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
  // Norse Atlantic UK (ICAO UBT), which flies LGW-JFK daily and rendered with
  // a route and no airline. It falls through BOTH tables: absent here, and the
  // device's operating-carrier table carries NBT -- Norse Atlantic Airways,
  // the Norwegian AOC -- but not UBT, its UK sibling. Adding it here rather
  // than only on the device also means no flash to fix a name.
  Z0: 'Norse Atlantic',
};

/**
 * A carrier's display name, from any of the three tables, or null.
 *
 * Takes EITHER vocabulary: a 2-character marketing IATA code (what a schedule
 * row carries) or a 3-letter operating ICAO code (all a live ADS-B callsign
 * yields). They cannot collide on length, so one function serves both callers
 * and neither has to know which kind of code it is holding.
 *
 * PRECEDENCE, shortest-and-most-curated first, because the panel gives an
 * airline 7 characters on a tracked card and 14 otherwise:
 *
 *   1. NAMES above -- 44 hand-picked marketing carriers, deliberately clipped
 *      to one word where a person would say one word ("Delta", not "Delta Air
 *      Lines").
 *   2. The firmware's own curated table, mirrored into airlines.device.ts.
 *      Also hand-written, also short, and ASCII by policy: "El Al", where the
 *      dataset says "EL AL Israel Airlines Ltd.".
 *   3. The generated dataset, which is where the long tail lives -- Arkia,
 *      and two thousand others that were previously rendering as a bare code.
 *
 * The order is the whole point. Ranking the dataset first would have "fixed"
 * Arkia at the cost of making a dozen familiar airlines wordier, which on a
 * 64px-wide panel means truncated.
 */
export function airlineName(code: string): string | null {
  const c = code.trim().toUpperCase();
  return NAMES[c] ?? DEVICE_CARRIER_NAMES[c] ?? CARRIER_NAMES[c] ?? null;
}
