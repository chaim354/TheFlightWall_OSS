#!/usr/bin/env node
// Generates src/schedule/airports.ts from OurAirports' public-domain
// airports.csv. Re-run this whenever the table needs refreshing:
//
//   node tools/gen-airports.js
//
// (from server/; an alternate output path can be passed as the first CLI
// arg, and --input <path> reads a local CSV instead of fetching one, mostly
// useful for offline testing against a saved snapshot.)
//
// Why this exists: AeroDataBox's FIDS rows never carry coordinates for the
// far end of a leg (see the header this script writes into airports.ts, and
// fixtures/README.md, for how that was confirmed). The schedule matcher
// needs both ends' coordinates to run its corridor-plausibility check
// (src/join.ts's excessFor/corridorExcessKm), so this script builds a
// bundled ICAO -> {iata, lat, lon} table from a public-domain source instead
// of hand-maintaining one airport at a time.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const INCLUDE_TYPES = new Set(['large_airport', 'medium_airport']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The DATA module only. src/schedule/airports.ts is hand-owned and must
// never be this script's target: it holds getAirportCoord,
// getAirportCoordByIata and the lazy IATA index, none of which the
// template below reproduces. Pointing this at airports.ts is what made
// `npm run gen:airports` delete them (F-SRV13-A). Asserted in
// test/airports.test.ts.
const DEFAULT_OUT = path.join(__dirname, '..', 'src', 'schedule', 'airports.data.ts');

function parseArgs(argv) {
  let input = null;
  let out = DEFAULT_OUT;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') { input = argv[++i]; continue; }
    positional.push(a);
  }
  if (positional[0]) out = path.resolve(positional[0]);
  return { input, out };
}

/**
 * Minimal RFC4180-style CSV parser: handles quoted fields, embedded commas,
 * escaped quotes (""), and embedded newlines inside quotes. OurAirports'
 * export happens not to use embedded newlines today (verified: the file's
 * line count matches its record count), but a generator meant to be re-run
 * against a live upstream file later should not quietly assume that stays
 * true -- a naive split(',')/split('\n') would corrupt rows like a
 * "Manhattan, New York City, NYC" keywords field the moment it did.
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

/**
 * Build the ICAO -> [iata, lat, lon] table from parsed CSV rows.
 *
 * Filter: `type` is large_airport or medium_airport; non-empty `ident`;
 * non-empty `iata_code`; latitude_deg/longitude_deg present and numeric.
 * small_airport is deliberately excluded -- it roughly doubles the row count
 * for zero measured coverage gain against fixtures/fids-kjfk.json (small
 * airports are not served by the scheduled airlines a FIDS board lists).
 *
 * Key: `icao_code` when OurAirports supplies one, else `ident`. NOT bare
 * `ident` unconditionally, even though `ident` is colloquially treated as
 * "the ICAO code" by most OurAirports tooling (and is exactly that for the
 * overwhelming majority of rows). It is not always true: 103 of the 4,565
 * rows that pass the filter above carry an OurAirports-internal placeholder
 * in `ident` (e.g. "AU-0539" for Western Sydney International) while the
 * real ICAO code a FIDS row would actually report -- YSWS, in that example
 * -- sits in `icao_code`. Keying those 103 rows by bare `ident` would not
 * shrink the table or change its count, it would just silently orphan them
 * under a string nothing will ever look up, which is exactly the coverage
 * gap this table exists to close. Preferring `icao_code` when present costs
 * nothing measured here (zero key collisions with the 4,565 rows this
 * produces either way), so there is no reason not to.
 */
function buildTable(rows) {
  const header = rows[0];
  if (!header) throw new Error('empty CSV: no header row');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const col of ['ident', 'type', 'latitude_deg', 'longitude_deg', 'icao_code', 'iata_code']) {
    if (!(col in idx)) throw new Error(`CSV is missing expected column "${col}" -- upstream shape changed`);
  }

  const table = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < header.length) continue;

    if (!INCLUDE_TYPES.has(row[idx.type])) continue;

    const ident = (row[idx.ident] ?? '').trim();
    const iata = (row[idx.iata_code] ?? '').trim();
    if (!ident || !iata) continue;

    // Explicit non-empty checks before Number() -- Number('') is 0, not NaN,
    // so a blank coordinate field would otherwise silently become a real
    // (0, 0) "Null Island" entry under a real ICAO key instead of being
    // dropped. Not observed in the current snapshot (checked: zero rows
    // anywhere in this file have a blank lat or lon), but a generator that
    // re-fetches a live file later should not depend on that staying true.
    const latStr = (row[idx.latitude_deg] ?? '').trim();
    const lonStr = (row[idx.longitude_deg] ?? '').trim();
    if (!latStr || !lonStr) continue;
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const icaoCode = (row[idx.icao_code] ?? '').trim();
    const key = (icaoCode || ident).toUpperCase();

    // 4 decimal places (~11 m) -- matches the precision the table this
    // replaces documented, more than enough for a 300 km plausibility check.
    table[key] = [
      iata.toUpperCase(),
      Math.round(lat * 10000) / 10000,
      Math.round(lon * 10000) / 10000,
    ];
  }
  return table;
}

function renderModule(table, meta) {
  const sortedKeys = Object.keys(table).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = table[k];
  const compact = JSON.stringify(sorted);
  const count = sortedKeys.length;

  return `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/gen-airports.js
// (from server/; see that script for the fetch/filter/key logic this
// header describes.)
//
// This module is DATA ONLY, and that split is load-bearing. The lookup
// functions live next door in ./airports.ts, which is hand-owned and which
// the generator never writes. They shared one file until 2026-08-23, and
// the generator's template did not reproduce the hand-written half -- so
// \`npm run gen:airports\` silently deleted getAirportCoordByIata and the
// lazy IATA index, taking the Port Authority provider's only route to
// coordinates with them. Regenerating is now a data-only diff by
// construction; it cannot remove logic. Keep it that way.
//
// Airport coordinate table: ICAO -> {iata, lat, lon}. Supplies BOTH the
// near end (this Worker's own boards: KJFK/KLGA/KEWR/KBOS) and the far end
// of every FIDS leg -- one unified table, not two. A FIDS row never carries
// coordinates for either end: confirmed by inspecting the captured fixture
// (../../fixtures/fids-kjfk.json) -- the far end's \`airport\` object carries
// only {icao, iata, name, countryCode, timeZone}, and grepping the whole
// 261-row file for \`lat\`/\`lon\`/\`location\` turns up nothing but two false
// positives ("Citation Latitude", an aircraft model, and "London", a city
// name). matchSchedule's corridor check and enrich()'s ETA calculation both
// need real coordinates for both ends, so this table supplies them.
//
// Earlier version of this file (see git history) shipped two separate
// tables instead: a 4-entry hand-maintained BOARD_AIRPORTS for the near end,
// and a 109-entry FAR_AIRPORT_COORDS bootstrap -- every *other* airport that
// happened to appear as a far end in one captured fixture, fetched one ICAO
// at a time from AeroDataBox's own Airport-by-ICAO endpoint. That bootstrap
// covered exactly the airports one capture at one board happened to surface;
// a diverted flight, a different day, or KLGA/KEWR/KBOS's own traffic would
// surface airports it did not have. This table replaces both: it is
// complete enough to subsume BOARD_AIRPORTS too (KJFK/KLGA/KEWR/KBOS are all
// large_airport rows with IATA codes in the source data below), which also
// removes a small pre-existing inconsistency the two-table version had --
// BOARD_AIRPORTS' KBOS and FAR_AIRPORT_COORDS' KBOS carried two different
// hand-typed values for the same airport. One table, one value each.
//
// Source: OurAirports' airports.csv --
//   ${SOURCE_URL}
// Public domain: OurAirports' own Terms of Use (https://ourairports.com/data/)
// states "All data is released to the Public Domain, and comes with no
// guarantee of accuracy or fitness for use"; the GitHub mirror this script
// pulls from (https://github.com/davidmegginson/ourairports-data) declares
// The Unlicense (SPDX: Unlicense) as its repository license. Checked
// directly against both sources when this file was generated, not assumed.
//
// Filter: \`type\` is \`large_airport\` or \`medium_airport\` (small_airport
// excluded -- roughly doubles row count for zero measured coverage gain
// against the fixture above; small airports are not served by the scheduled
// airlines a FIDS board lists); non-empty \`ident\`; non-empty \`iata_code\`;
// latitude_deg/longitude_deg present and numeric. Keyed by \`icao_code\` when
// present, else \`ident\` -- see tools/gen-airports.js for why that is not
// simply \`ident\` unconditionally despite the filter criterion being phrased
// that way (bare \`ident\` is an OurAirports-internal placeholder, not a real
// ICAO code, for 103 of the rows below). Coordinates rounded to 4 decimal
// places (~11 m).
//
// Row count: ${count.toLocaleString('en-US')}. Generated: ${meta.date}.
//
// Values are stored as [iata, lat, lon] tuples rather than {iata, lat, lon}
// objects -- repeating three field-name strings across ${count.toLocaleString('en-US')} entries costs
// roughly 90 KB of pure key-label bytes for no informational gain over a
// documented, fixed order. Use getAirportCoord() from ./airports.ts for
// named-field access; nothing outside this pair should reach into the
// tuple table directly.

export const AIRPORT_TUPLES: Readonly<Record<string, readonly [iata: string, lat: number, lon: number]>> =
${compact} as const;
`;
}

async function loadCsvText(input) {
  if (input) {
    return readFileSync(input, 'utf8');
  }
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch ${SOURCE_URL} -> ${res.status}`);
  return res.text();
}

async function main() {
  const { input, out } = parseArgs(process.argv.slice(2));
  console.log(input ? `Reading ${input} ...` : `Fetching ${SOURCE_URL} ...`);
  const csvText = await loadCsvText(input);

  const rows = parseCsv(csvText);
  console.log(`Parsed ${(rows.length - 1).toLocaleString('en-US')} data rows.`);

  const table = buildTable(rows);
  const count = Object.keys(table).length;
  console.log(`Filtered to ${count.toLocaleString('en-US')} airports.`);

  // Refuse to overwrite a good table with a broken one: the filter and key
  // logic above are the load-bearing part of this script, and a silent
  // upstream shape change (a renamed column, a near-empty file from a
  // transient fetch problem) should fail loudly here rather than produce a
  // near-empty airports.ts.
  if (count < 4000) {
    throw new Error(`only ${count} airports passed the filter -- expected roughly 4,565; refusing to write a possibly-broken table`);
  }
  for (const sanityIcao of ['KJFK', 'EGLL']) {
    if (!table[sanityIcao]) {
      throw new Error(`sanity check failed: ${sanityIcao} is missing from the filtered table`);
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const moduleText = renderModule(table, { date });
  writeFileSync(out, moduleText, 'utf8');

  const bytes = Buffer.byteLength(moduleText, 'utf8');
  console.log(`Wrote ${out} (${count.toLocaleString('en-US')} airports, ${(bytes / 1024).toFixed(1)} KB).`);
}

// Exported so test/airports.test.ts can re-render the committed table and
// assert it matches byte-for-byte. That check is the one that would have
// caught F-SRV13-A: the template and its output had silently disagreed since
// 2026-08-21, and nothing compared them.
export { renderModule, buildTable, parseCsv };

// Only run when invoked as a script, so importing for that test does not
// trigger a network fetch.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('gen-airports failed:', err.message);
    process.exitCode = 1;
  });
}
