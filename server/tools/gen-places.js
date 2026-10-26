#!/usr/bin/env node
// Generates src/places.data.ts -- the towns a tracked card can say it is
// flying over -- from GeoNames' cities5000 export. Re-run whenever the table
// needs refreshing:
//
//   node tools/gen-places.js
//
// (from server/; an alternate output path can be passed as the first CLI
// arg. --input <cities5000.zip|.txt> and --countries <countryInfo.txt> read
// local copies instead of fetching, mostly useful offline.)
//
// Why a bundled table and not a reverse-geocoding API: the lookup runs on
// every /v1/flights request that carries a tracked card, and a card must never
// wait on, or fail because of, a third party nobody pays. Nominatim's policy
// is one request a second with caching; this is a few microseconds and has no
// failure mode at all. Same reasoning as the airport table next door.
//
// Why cities5000 and not cities1000: the names have to mean something to a
// person reading a wall from across a room. Population 5,000 is a town; 1,000
// is a village most people outside its county have never heard of, and
// "flying over" one is a less useful sentence than "near" the town beside it.
// It is also 2MB rather than 5MB.
//
// LICENCE: GeoNames data is CC BY 4.0. The attribution lives in the header
// this script writes, and must stay there.

import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CITIES_URL = 'https://download.geonames.org/export/dump/cities5000.zip';
const COUNTRIES_URL = 'https://download.geonames.org/export/dump/countryInfo.txt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The DATA module only. src/places.ts holds the lookup and is hand-owned; see
// gen-airports.js's F-SRV13-A note for why the generator never writes logic.
const DEFAULT_OUT = path.join(__dirname, '..', 'src', 'places.data.ts');

function parseArgs(argv) {
  let input = null;
  let countries = null;
  let out = DEFAULT_OUT;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') { input = argv[++i]; continue; }
    if (a === '--countries') { countries = argv[++i]; continue; }
    positional.push(a);
  }
  if (positional[0]) out = path.resolve(positional[0]);
  return { input, countries, out };
}

/**
 * Province and state abbreviations for the two countries whose GeoNames
 * admin1 codes are NUMBERS. "Toronto, 08" means nothing; "Toronto, ON" is how
 * the place is written. The US needs no table -- its admin1 codes already ARE
 * the postal abbreviations.
 */
const ADMIN1_ABBREV = {
  CA: {
    '01': 'AB', '02': 'BC', '03': 'MB', '04': 'NB', '05': 'NL', '07': 'NS',
    '08': 'ON', '09': 'PE', '10': 'QC', '11': 'SK', '12': 'YT', '13': 'NT', '14': 'NU',
  },
  AU: {
    '01': 'ACT', '02': 'NSW', '03': 'NT', '04': 'QLD', '05': 'SA', '06': 'TAS', '07': 'VIC', '08': 'WA',
  },
};

/**
 * Shorter forms of country names that would otherwise eat a 21-column panel
 * row by themselves. The device drops the region entirely when "Town, Region"
 * does not fit, so this only decides how often it gets to keep it.
 */
const COUNTRY_SHORT = {
  AE: 'UAE',
  BA: 'Bosnia',
  CD: 'DR Congo',
  CF: 'CAR',
  CG: 'Congo',
  DO: 'Dominican Rep.',
  GB: 'UK',
  NL: 'Netherlands',
  PG: 'PNG',
  PS: 'Palestine',
  TT: 'Trinidad',
  US: 'USA',
};

/** The display region for one place: state/province where people use one, else the country. */
function regionOf(country, admin1, countryNames) {
  if (country === 'US') return admin1 || 'USA';
  const abbrev = ADMIN1_ABBREV[country]?.[admin1];
  if (abbrev) return abbrev;
  return COUNTRY_SHORT[country] ?? countryNames[country] ?? country;
}

function parseCountries(text) {
  const names = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f[0] && f[4]) names[f[0]] = f[4].trim();
  }
  return names;
}

/**
 * Feature codes that are not a town in their own right: a SECTION of one
 * (PPLX -- city neighbourhoods and boroughs, 5,300 of them), or a place that
 * is historical, abandoned or destroyed. "Over Vaugirard" is less useful than
 * "over Paris", and "over" somewhere that no longer exists is wrong.
 */
const SKIP_FEATURES = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW']);

/**
 * French-style numbered districts that GeoNames files as ordinary PPL rows --
 * "Lyon 05", "Paris 15 Vaugirard", "Marseille 01". A standalone one- or
 * two-digit token in a name is that pattern and essentially never a real
 * town's name.
 */
const NUMBERED_DISTRICT = /(^|\s)\d{1,2}(\s|$)/;

/**
 * GeoNames rows -> [name, region, lat, lon], ASCII names only.
 *
 * The ASCII column, not the native one: the panel's 6x8 GFX font has no
 * glyph for "è" or "ł", and a name with a hole in it is worse than the plain
 * transliteration everybody recognises. Anything still non-ASCII after that is
 * dropped rather than half-drawn.
 */
function buildRows(citiesText, countryNames) {
  const rows = [];
  for (const line of citiesText.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    const name = (f[2] ?? '').trim();
    const lat = Number(f[4]);
    const lon = Number(f[5]);
    if (!name || !/^[\x20-\x7e]+$/.test(name)) continue;
    if (SKIP_FEATURES.has(f[7] ?? '') || NUMBERED_DISTRICT.test(name)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push([name, regionOf(f[8] ?? '', f[10] ?? '', countryNames), lat, lon]);
  }
  // Stable output for a stable input: diffs between regenerations should show
  // what GeoNames changed, not what order it happened to export in.
  rows.sort((a, b) => a[2] - b[2] || a[3] - b[3] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

function renderModule(rows, meta) {
  // Two decimals is ~1km, which is far finer than any "over"/"near" decision
  // made from it, and it is what keeps this file at 2MB rather than 3.
  const body = rows
    .map(([name, region, lat, lon]) => `  ${JSON.stringify(`${name}\t${region}\t${lat.toFixed(2)}\t${lon.toFixed(2)}`)},`)
    .join('\n');
  return `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/gen-places.js
// (from server/; see that script for the source, filter and region rules.)
//
// DATA ONLY: the lookup lives in ./places.ts, which the generator never
// writes, for the reason ./schedule/airports.data.ts gives in full.
//
// ${rows.length.toLocaleString('en-US')} populated places of 5,000 or more people, as
// "name<TAB>region<TAB>lat<TAB>lon". Generated ${meta.date}.
//
// Source: GeoNames (https://www.geonames.org/), cities5000 export.
// Licensed under Creative Commons Attribution 4.0 -- CC BY 4.0,
// https://creativecommons.org/licenses/by/4.0/. Names are GeoNames' ASCII
// transliterations; regions are US/CA/AU state or province abbreviations, else
// the country name.

export const PLACE_ROWS: readonly string[] = [
${body}
];
`;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  return res.text();
}

/** cities5000 ships as a zip; unzip(1) is on every machine this is run from. */
function readCitiesZip(zipPath) {
  return execFileSync('unzip', ['-p', zipPath, 'cities5000.txt'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function loadCities(input) {
  if (input) return input.endsWith('.zip') ? readCitiesZip(input) : readFileSync(input, 'utf8');
  const dir = mkdtempSync(path.join(tmpdir(), 'gen-places-'));
  try {
    const res = await fetch(CITIES_URL);
    if (!res.ok) throw new Error(`fetch ${CITIES_URL} failed: HTTP ${res.status}`);
    const zip = path.join(dir, 'cities5000.zip');
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    return readCitiesZip(zip);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { input, countries, out } = parseArgs(process.argv.slice(2));
  console.log(input ? `Reading ${input} ...` : `Fetching ${CITIES_URL} ...`);
  const citiesText = await loadCities(input);
  const countryNames = parseCountries(countries ? readFileSync(countries, 'utf8') : await fetchText(COUNTRIES_URL));

  const rows = buildRows(citiesText, countryNames);
  console.log(`Kept ${rows.length.toLocaleString('en-US')} places.`);

  // Refuse to overwrite a good table with a broken one -- a truncated download
  // or a renamed column should fail here, not ship a wall that is "over"
  // nowhere.
  if (rows.length < 50000) {
    throw new Error(`only ${rows.length} places parsed -- expected roughly 70,000; refusing to write a possibly-broken table`);
  }
  for (const [name, region] of [['Springfield', 'IL'], ['Toronto', 'ON'], ['London', 'UK'], ['Lyon', 'France']]) {
    if (!rows.some((r) => r[0] === name && r[1] === region)) {
      throw new Error(`sanity check failed: ${name}, ${region} is missing`);
    }
  }

  const moduleText = renderModule(rows, { date: new Date().toISOString().slice(0, 10) });
  writeFileSync(out, moduleText, 'utf8');
  const bytes = Buffer.byteLength(moduleText, 'utf8');
  console.log(`Wrote ${out} (${rows.length.toLocaleString('en-US')} places, ${(bytes / 1024).toFixed(1)} KB).`);
}

export { renderModule, buildRows, parseCountries, regionOf };

// Only run when invoked as a script, so importing for a test does not trigger
// a network fetch.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('gen-places failed:', err.message);
    process.exitCode = 1;
  });
}
