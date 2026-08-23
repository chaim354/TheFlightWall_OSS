// Hand-owned. The 4,565-row coordinate table this reads lives in
// ./airports.data.ts, which IS generated -- see that file's header.
//
// Keeping the lookups here rather than in the generated module is the whole
// point: `npm run gen:airports` overwrites its output wholesale, and while
// these functions lived in that output they were deleted by every
// regeneration (F-SRV13-A, 2026-08-23 audit). Nothing in this file is
// reproduced by the generator's template, so nothing in it can be lost.

import { AIRPORT_TUPLES } from './airports.data';

/** IATA code and coordinates for one airport. */
export type AirportCoord = { iata: string; lat: number; lon: number };

/**
 * Look up an airport's IATA code and coordinates by ICAO code (case
 * insensitive). Returns undefined -- never throws -- for an ICAO code not in
 * the table, which is the expected, common case for an airport this table's
 * source simply does not cover (e.g. most small_airport-type fields, or a
 * real-world airport OurAirports has not catalogued). A caller degrading
 * that to "cannot check this leg" rather than trusting it unchecked is the
 * point -- see src/join.ts's excessFor and src/schedule/aerodatabox.ts.
 */
export function getAirportCoord(icao: string): AirportCoord | undefined {
  const t = AIRPORT_TUPLES[icao.toUpperCase()];
  return t ? { iata: t[0], lat: t[1], lon: t[2] } : undefined;
}

/**
 * IATA -> ICAO, built once on first use.
 *
 * Exists because not every provider keys on ICAO. AeroDataBox's FIDS gives
 * both codes, so `getAirportCoord` above suffices for it; the Port Authority
 * boards (src/schedule/panynj.ts) give ONLY IATA -- `destinationAirportCode:
 * "ORD"` -- with no ICAO anywhere in the payload, so a reverse index is the
 * only way to reach coordinates for those rows.
 *
 * Safe to invert: IATA codes are unique across this table -- 4,565 entries,
 * 4,565 distinct IATA codes, zero collisions (measured against the generated
 * table, and asserted in test/airports.test.ts so a future regeneration that
 * introduced one would fail rather than silently pick a winner). That is a
 * property of this filtered table, not of IATA codes in general: the
 * generator already requires a non-empty `iata_code` and drops the airport
 * types most likely to carry a reused or informal code.
 *
 * Built lazily rather than at module load so the cost is paid only by
 * deployments that actually use an IATA-keyed provider.
 */
let iataIndex: Record<string, string> | null = null;

function iataToIcao(): Record<string, string> {
  if (!iataIndex) {
    const idx: Record<string, string> = {};
    for (const icao of Object.keys(AIRPORT_TUPLES)) idx[AIRPORT_TUPLES[icao]![0]] = icao;
    iataIndex = idx;
  }
  return iataIndex;
}

/**
 * Look up an airport by IATA code (case insensitive). Same contract as
 * `getAirportCoord`: returns undefined, never throws, for a code this table
 * does not cover -- which a caller must degrade to "cannot check this leg"
 * rather than trusting unchecked.
 */
export function getAirportCoordByIata(iata: string): AirportCoord | undefined {
  const icao = iataToIcao()[iata.toUpperCase()];
  return icao ? getAirportCoord(icao) : undefined;
}
