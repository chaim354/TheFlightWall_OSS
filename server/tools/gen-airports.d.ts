// Type surface for the helpers gen-airports.js exports so
// test/airports.test.ts can re-render the committed table and compare it.
//
// The generator itself stays plain ESM JavaScript: it is a standalone
// maintenance script, not part of the Worker bundle, and tsconfig.json's
// `include` deliberately covers only src/** and test/**. TypeScript still
// resolves this declaration because it sits next to the .js file it describes.

export type AirportTuple = readonly [iata: string, lat: number, lon: number];

/** ICAO -> [iata, lat, lon], as stored in src/schedule/airports.data.ts. */
export type AirportTable = Readonly<Record<string, AirportTuple>>;

/**
 * Render the complete text of src/schedule/airports.data.ts for `table`.
 * Data only -- it emits no functions, which is what keeps regeneration from
 * deleting the hand-owned lookups in src/schedule/airports.ts (F-SRV13-A).
 */
export declare function renderModule(table: AirportTable, meta: { date: string }): string;

/** Filter + key the parsed OurAirports CSV rows down to the shipped table. */
export declare function buildTable(rows: string[][]): Record<string, AirportTuple>;

/** Parse CSV text into rows of fields. */
export declare function parseCsv(text: string): string[][];
