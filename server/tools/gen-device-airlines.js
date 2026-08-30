#!/usr/bin/env node
// Generates src/airlines.device.ts from firmware/utils/AirlineNames.h.
//
//   node tools/gen-device-airlines.js
//
// (from server/; an alternate output path can be passed as the first CLI arg,
// and --input <path> reads a different header, used by the tests.)
//
// WHY A GENERATOR RATHER THAN A COPY. The firmware has carried a hand-curated
// ICAO -> name table for a long time, and its names are BETTER than the ones a
// dataset gives, on purpose: they are short and ASCII, because the panel font
// has no accented glyphs and the airline gets 7 to 14 characters on a card.
// Wikidata says "EL AL Israel Airlines Ltd." where that table says "El Al",
// and "Swiss International Air Lines" where it says "Swiss".
//
// Moving the resolution to the server (so a name needs no flash) therefore
// must not lose them -- but a hand-copied duplicate of 178 entries is a
// guaranteed future drift, where the wall shows one name over the LAN page and
// another on the panel and nobody can say which table is stale. Deriving the
// server's copy from the header keeps one source of truth: edit the header,
// re-run this, and the two cannot disagree.
//
// The header stays the authority because it is also the OFFLINE fallback: a
// board that cannot reach the server still names its own traffic from it.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IN = path.join(__dirname, '..', '..', 'firmware', 'utils', 'AirlineNames.h');
const DEFAULT_OUT = path.join(__dirname, '..', 'src', 'airlines.device.ts');

function parseArgs(argv) {
  let input = DEFAULT_IN;
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
 * Pull {"ICAO", "Name"} pairs out of the C initialiser.
 *
 * A regex over C source is usually a bad idea; here the target is a literal
 * table of two string literals per line, written by hand in a fixed shape, and
 * the alternative is a C parser. The floor check in main() is what keeps this
 * honest: if the header's shape ever changes enough to break the match, the
 * build fails loudly instead of writing a table with three entries in it.
 */
export function parseHeader(source) {
  const table = {};
  const re = /\{\s*"([A-Z0-9]{3})"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const icao = m[1];
    // The header is ASCII by policy, but it is C: honour the escapes it could
    // legally contain rather than shipping a literal backslash to the panel.
    const name = m[2].replace(/\\(.)/g, '$1').trim();
    if (name) table[icao] = name;
  }
  return table;
}

function renderModule(table, meta) {
  const sortedKeys = Object.keys(table).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = table[k];

  return `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/gen-device-airlines.js
// (from server/; the source of truth is the firmware header named below.)
//
// The firmware's own curated ICAO -> name table, mirrored so the SERVER can
// answer with it. Same names, same spellings, one source.
//
// These names are short and ASCII deliberately -- the panel font has no
// accented glyphs and a card gives the airline 7 to 14 characters -- which is
// why they take precedence over the much larger generated table in
// ./airlines.data.ts: that one has "EL AL Israel Airlines Ltd." where this has
// "El Al". Precedence lives in ./airlines.ts.
//
// ${sortedKeys.length} carriers, from ${meta.source}.
export const DEVICE_CARRIER_NAMES: Readonly<Record<string, string>> = ${JSON.stringify(sorted)};
`;
}

function main() {
  const { input, out } = parseArgs(process.argv.slice(2));
  const table = parseHeader(readFileSync(input, 'utf8'));

  // The header has had 170+ entries for a long time. A sudden collapse means
  // the shape changed and this regex stopped matching -- which would otherwise
  // ship as a silent quality regression on the wall, not as a build failure.
  const count = Object.keys(table).length;
  if (count < 100) {
    throw new Error(`only ${count} entries parsed from ${input} -- header shape changed?`);
  }

  writeFileSync(out, renderModule(table, { source: 'firmware/utils/AirlineNames.h' }), 'utf8');
  console.log(`wrote ${out}: ${count} carriers`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
