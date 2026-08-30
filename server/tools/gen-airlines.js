#!/usr/bin/env node
// Generates src/airlines.data.ts from the ADS-B community operator database
// (Mictronics) for ICAO codes, and OpenFlights for IATA codes.
//
//   node tools/gen-airlines.js
//
// (from server/; an alternate output path can be passed as the first CLI arg,
// and --operators/--openflights <path> read saved snapshots instead of
// fetching, which is how the tests exercise the build without a network.)
//
// WHY THIS EXISTS. src/airlines.ts is 44 marketing carriers, hand-picked and
// deliberately SHORT because the panel is 64px wide. The firmware carries its
// own 178 operating carriers. Between them they cover the majors and nothing
// else -- so Arkia, which flies AIZ994 into JFK daily, rendered on the wall as
// the bare string "AIZ". Fixing that by hand means editing one of two tables
// per airline, and the firmware one means a FLASH, for a name.
//
// Build time, not request time: the wall must not depend on a third party
// being up to know what an airline is called, and a table in the bundle costs
// nothing per request.
//
// WHY MICTRONICS FOR ICAO. Measured against the 178 ICAO codes the firmware
// curates -- a decent proxy for "codes that actually fly past a wall" -- three
// candidates were compared when this was written:
//
//   mictronics    5,508 entries   covers 174/178   avg name 19.1 chars
//   wikidata      1,550 entries   covers 145/178   avg name 14.4 chars
//   openflights   1,018 entries   covers 141/178   avg name 14.7 chars
//
// Not close. Mictronics is the operator database the ADS-B tooling ecosystem
// maintains for exactly this lookup -- 3-letter ICAO operator designator to
// name -- which is precisely the key a live callsign yields, so its coverage
// is aligned with what a receiver actually hears rather than with what has an
// encyclopaedia article. Its names run longer, which does not matter here:
// airlines.ts ranks both curated tables ahead of this one, so the long form
// only ever appears where the alternative was a bare code.
//
// OpenFlights supplies the IATA half, filtered to active carriers, because
// Mictronics is ICAO-only and a schedule row speaks IATA.
//
// DEFUNCT CARRIERS. OpenFlights rows are filtered on its own `active` flag,
// for a reason worth stating: an IATA designator is REUSED after a carrier
// folds, so a table that keeps dead entries will confidently name today's
// flight after an airline that stopped flying in 1997. A bare code is a much
// better outcome than a wrong name -- the same argument src/airlines.ts makes
// about returning null rather than substituting a code. Mictronics has no such
// flag; it is a live-operations database and carries what is heard on the air.
//
// LICENSING. Unlike airports.data.ts (OurAirports, public domain) neither of
// these is a public-domain dedication: the Mictronics database ships inside
// readsb and OpenFlights' data is ODbL. This was generated on the owner's
// explicit instruction that licensing is not a constraint for this use. If
// this table is ever redistributed beyond that, the licences are the thing to
// revisit first.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Both sources are served by hosts entitled to know who is asking, and an
// anonymous bulk fetch is the kind a rate limiter is right to refuse.
const USER_AGENT =
  'FlightWall-airline-table/1.0 (https://github.com/chaim354/TheFlightWall_OSS)';

const OPERATORS_URL =
  'https://raw.githubusercontent.com/Mictronics/readsb/dev/webapp/src/db/operators.json';
const OPENFLIGHTS_URL =
  'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(__dirname, '..', 'src', 'airlines.data.ts');

function parseArgs(argv) {
  let operators = null;
  let openflights = null;
  let out = DEFAULT_OUT;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--operators') { operators = argv[++i]; continue; }
    if (a === '--openflights') { openflights = argv[++i]; continue; }
    positional.push(a);
  }
  if (positional[0]) out = path.resolve(positional[0]);
  return { operators, openflights, out };
}

/**
 * Wikidata labels carry disambiguators that are not part of the name a person
 * reads off a wall: "Volaris (airline)", "Jet2.com (airline)". Strip a single
 * trailing parenthetical and collapse whitespace; leave everything else alone,
 * because guessing further -- dropping "Airlines", say -- is the DEVICE's job
 * and it already does it (Hub75Display's stripAirlineWords) with knowledge of
 * whether a logo tile is showing to carry the meaning instead.
 */
function cleanName(raw) {
  let s = String(raw).replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
  // Trailing corporate form. "EL AL Israel Airlines Ltd." is a legal entity;
  // "EL AL Israel Airlines" is what a person calls it, and on a card that gives
  // the airline 7 to 14 characters, four of them spent on "Ltd." are four the
  // actual name does not get. Looped, because they stack ("Pty Ltd").
  //
  // ONLY unambiguous forms -- punctuated, or a word no airline name contains.
  // "AB", "AS", "SA", "NV" are deliberately NOT here: they are real corporate
  // suffixes, but stripping a bare two-letter trailing token would also eat
  // part of a genuine name, and a mangled name is worse than a verbose one.
  const SUFFIX =
    /[,\s]+(?:Ltd\.?|Limited|Inc\.?|Incorporated|L\.?L\.?C\.?|P\.?L\.?C\.?|Corp\.?|Corporation|Company|Co\.|GmbH|S\.A\.|S\.p\.A\.|d\.o\.o\.|J\.?S\.?C\.?|P\.?J\.?S\.?C\.?|LLP|Pty|Pte|A\/S|AG)$/i;
  let prev;
  do { prev = s; s = s.replace(SUFFIX, '').trim(); } while (s !== prev && s.length > 0);
  return s;
}

const isIata = (s) => /^[A-Z0-9]{2}$/.test(s) && /[A-Z]/.test(s);
const isIcao = (s) => /^[A-Z]{3}$/.test(s);

/**
 * Minimal RFC4180-style CSV parser -- lifted from gen-airports.js, and needed
 * for the same reason: OpenFlights quotes its name fields and several contain
 * commas ("Scandinavian Airlines System, SAS"), so a split(',') corrupts them.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Mictronics operators.json: { "AAL": {n, c, r}, ... } -> ICAO -> name. */
export function buildFromOperators(payload) {
  const table = {};
  for (const [rawCode, entry] of Object.entries(payload ?? {})) {
    const code = String(rawCode).trim().toUpperCase();
    if (!isIcao(code)) continue;
    const name = cleanName(entry?.n ?? '');
    if (name) table[code] = name;
  }
  return table;
}

/**
 * OpenFlights airlines.dat -> IATA -> name, active carriers only.
 *
 * Headerless CSV: id, name, alias, iata, icao, callsign, country, active.
 *
 * A code claimed by more than one ACTIVE airline is DROPPED rather than
 * resolved, because any tie-break would be a guess dressed up as data and a
 * confident wrong name is indistinguishable from a right one -- whereas a bare
 * code is visibly incomplete. Whatever this drops stays reachable through the
 * page\'s own airline-name override.
 */
export function buildFromOpenFlights(text) {
  const claims = new Map();
  for (const row of parseCsv(text)) {
    if (row.length < 8) continue;
    const name = cleanName(row[1] ?? '');
    const iata = String(row[3] ?? '').trim().toUpperCase();
    const active = String(row[7] ?? '').trim();
    if (!name || name === '\\N' || active !== 'Y') continue;
    if (!isIata(iata)) continue;
    if (!claims.has(iata)) claims.set(iata, new Set());
    claims.get(iata).add(name);
  }

  const table = {};
  let dropped = 0;
  for (const [code, names] of claims) {
    if (names.size !== 1) { dropped++; continue; }
    table[code] = [...names][0];
  }
  return { table, dropped };
}

function renderModule(icao, iata, meta) {
  const merged = { ...icao, ...iata };
  const sortedKeys = Object.keys(merged).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = merged[k];

  return `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/gen-airlines.js
// (from server/; see that script for the sources, the measurements behind
// choosing them, the filters, and the licensing note.)
//
// This module is DATA ONLY, and that split is load-bearing for exactly the
// reason airports.data.ts\'s header gives: the lookup lives next door in
// ./airlines.ts, which is hand-owned, holds the short curated names that must
// keep beating these, and which the generator never writes. Regenerating is a
// data-only diff by construction.
//
// Carrier name table: IATA (2 chars) or ICAO (3 letters) -> airline name.
// ONE table, both vocabularies, because they cannot collide -- an IATA airline
// designator is two characters and an ICAO one is three -- and because the two
// callers hold different halves: a schedule row knows the marketing IATA code,
// while a live ADS-B callsign yields only the operating ICAO prefix.
//
// ${sortedKeys.length} carriers: ${Object.keys(icao).length} ICAO from the
// Mictronics operator database, ${Object.keys(iata).length} IATA from
// OpenFlights (active carriers only; ${meta.dropped} ambiguous codes dropped).
//
// Sources:
//   ${OPERATORS_URL}
//   ${OPENFLIGHTS_URL}
//
// These names run longer than the two curated tables\' and that is fine --
// airlines.ts ranks both of those ahead of this one, so a long form only ever
// appears where the alternative was a bare operator code.
export const CARRIER_NAMES: Readonly<Record<string, string>> = ${JSON.stringify(sorted)};
`;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} for ${url}`);
  return res.text();
}

async function main() {
  const { operators, openflights, out } = parseArgs(process.argv.slice(2));

  const opsText = operators ? readFileSync(operators, 'utf8') : await fetchText(OPERATORS_URL);
  const ofText = openflights ? readFileSync(openflights, 'utf8') : await fetchText(OPENFLIGHTS_URL);

  const icaoTable = buildFromOperators(JSON.parse(opsText));
  const { table: iataTable, dropped } = buildFromOpenFlights(ofText);

  // Sanity floors, not guesses. The measurements in this file\'s header put
  // these at 5,508 and ~1,000; anything far below means an upstream shape
  // changed and the table would be a REGRESSION shipped quietly. Better to
  // fail the build than to overwrite a good table with a truncated one.
  if (Object.keys(icaoTable).length < 3000) {
    throw new Error(`only ${Object.keys(icaoTable).length} ICAO operators -- upstream shape changed?`);
  }
  if (Object.keys(iataTable).length < 500) {
    throw new Error(`only ${Object.keys(iataTable).length} IATA carriers -- upstream shape changed?`);
  }

  writeFileSync(out, renderModule(icaoTable, iataTable, { dropped }), 'utf8');
  console.log(
    `wrote ${out}: ${Object.keys(icaoTable).length} ICAO + ${Object.keys(iataTable).length} IATA` +
      ` (${dropped} ambiguous IATA codes dropped)`,
  );
}

// Importable for tests without running the fetch.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
