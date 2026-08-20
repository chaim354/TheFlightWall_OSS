// Airport coordinate tables. Pure data, no I/O.
//
// A FIDS row never carries coordinates for either end of a leg -- confirmed by
// inspecting the captured fixture (../../fixtures/fids-kjfk.json): the
// `airport` object on the far end carries only
// {icao, iata, name, countryCode, timeZone}, and grep across the whole 261-row
// file turns up no `lat`/`lon`/`location` key anywhere (the two false-positive
// substring hits are "Citation Latitude", an aircraft model, and "London", a
// city name). matchSchedule's corridor check and enrich()'s ETA calculation
// both need real coordinates, so this file supplies them from two different
// places for two different reasons.

/**
 * The four airports this Worker polls. A FIDS row never represents its own
 * board airport as an `airport` object (only the far end gets one), so the
 * near end has to come from somewhere fixed regardless of which provider is
 * behind AeroDataBox on a given day. Small and stable enough to hand-maintain.
 */
export const BOARD_AIRPORTS: Readonly<Record<string, { iata: string; lat: number; lon: number }>> = {
  KJFK: { iata: 'JFK', lat: 40.6413, lon: -73.7781 },
  KLGA: { iata: 'LGA', lat: 40.7769, lon: -73.8740 },
  KEWR: { iata: 'EWR', lat: 40.6895, lon: -74.1745 },
  KBOS: { iata: 'BOS', lat: 42.3656, lon: -71.0096 },
};

/**
 * Every *other* airport that appeared as the far end of a leg in the captured
 * fixture. Unlike BOARD_AIRPORTS, this could not be hand-maintained -- a
 * single 6-hour window at one board already touches 109 distinct airports on
 * six continents -- so these were not guessed. Each entry was fetched live,
 * one ICAO code at a time, from AeroDataBox's own Airport-by-ICAO endpoint:
 *
 *   GET https://aerodatabox.p.rapidapi.com/airports/icao/{icao}
 *   -> { icao, iata, shortName, fullName, location: { lat, lon }, ... }
 *
 * on 2026-08-20, using the same key this Worker uses for FIDS. That endpoint
 * is billed Tier 1 (1 credit unit/call, confirmed from the response's
 * `x-ratelimit-api-units-remaining` header moving by exactly 1 per call --
 * half the FIDS endpoint's Tier 2 cost) -- 109 one-time lookups cost 109
 * units, a bootstrap cost against the 600-unit free tier, not a recurring
 * one: the Worker itself never calls this endpoint, it only reads this table.
 * Coordinates rounded to 4 decimal places (~11 m), matching BOARD_AIRPORTS.
 *
 * KNOWN GAP, not closed here: this covers exactly the far-end airports seen
 * in one capture at one of the four boards. A different day, a diverted
 * flight, or KLGA/KEWR/KBOS's own traffic will surface airports not in this
 * table -- a real, ongoing gap, not a one-time fixup. A row whose far end is
 * missing degrades safely rather than failing: it keeps its `iata` code and
 * carrier for display and for the exact-callsign join path (neither needs
 * coordinates), it just cannot use the corridor-plausibility fallback or
 * report an ETA for that specific leg (matchSchedule already drops a
 * candidate it cannot geometrically check rather than trusting it unchecked,
 * and enrich() already renders a flight with no ETA when the destination has
 * no coordinates -- see join.ts and enrich.ts). Options for closing the gap
 * for real, deliberately not attempted here because each changes the
 * Worker's runtime shape rather than adapting Task 7's parser to the fixture:
 *   1. Bundle a full public-domain airport database (e.g. OurAirports'
 *      airports.csv, public domain) instead of a bespoke table -- static, no
 *      runtime cost, but a much bigger bundle and an external data dependency
 *      to keep current.
 *   2. Call this same Airport-by-ICAO endpoint lazily at runtime for an
 *      airport not yet in KV, and cache the result forever (airport
 *      locations do not change) -- no bundle-size cost, but a new KV-backed
 *      cache, a new failure mode (a brand-new airport briefly has no ETA
 *      until its first lookup succeeds), and per-airport credit cost that
 *      scales with how many new airports show up, not just how many boards
 *      are polled.
 */
export const FAR_AIRPORT_COORDS: Readonly<Record<string, { lat: number; lon: number }>> = {
  BIKF: { lat: 63.985, lon: -22.6056 }, // KEF Keflavik
  CYYC: { lat: 51.1139, lon: -114.02 }, // YYC Calgary
  CYYZ: { lat: 43.6772, lon: -79.6306 }, // YYZ Pearson
  EDDF: { lat: 50.0264, lon: 8.5431 }, // FRA Frankfurt-am-Main
  EFHK: { lat: 60.3172, lon: 24.9633 }, // HEL Vantaa
  EGCC: { lat: 53.3537, lon: -2.275 }, // MAN Manchester
  EGLL: { lat: 51.4706, lon: -0.4619 }, // LHR Heathrow
  EGPH: { lat: 55.95, lon: -3.3725 }, // EDI Edinburgh
  EHAM: { lat: 52.3086, lon: 4.7639 }, // AMS Schiphol
  EIDW: { lat: 53.4213, lon: -6.2701 }, // DUB Dublin
  EPWA: { lat: 52.1657, lon: 20.9671 }, // WAW Chopin
  GMMN: { lat: 33.3675, lon: -7.59 }, // CMN Mohammed V
  KATL: { lat: 33.6367, lon: -84.4281 }, // ATL Hartsfield Jackson
  KAUS: { lat: 30.1945, lon: -97.6699 }, // AUS Bergstrom
  KBDL: { lat: 41.9389, lon: -72.6832 }, // BDL Bradley
  KBNA: { lat: 36.1245, lon: -86.6782 }, // BNA Nashville
  KBOS: { lat: 42.3643, lon: -71.0052 }, // BOS Logan (near end elsewhere too; see BOARD_AIRPORTS)
  KBTV: { lat: 44.4719, lon: -73.1533 }, // BTV Burlington
  KBUF: { lat: 42.9405, lon: -78.7322 }, // BUF Niagara
  KCHS: { lat: 32.8986, lon: -80.0405 }, // CHS Charleston AFB
  KCLE: { lat: 41.4117, lon: -81.8498 }, // CLE Hopkins
  KCLT: { lat: 35.214, lon: -80.9431 }, // CLT Douglas
  KCMH: { lat: 39.998, lon: -82.8919 }, // CMH Port Columbus
  KCVG: { lat: 39.0488, lon: -84.6678 }, // CVG Northern Kentucky
  KDCA: { lat: 38.8521, lon: -77.0377 }, // DCA Ronald Reagan National
  KDEN: { lat: 39.8617, lon: -104.673 }, // DEN Denver
  KDFW: { lat: 32.8968, lon: -97.038 }, // DFW Dallas-Fort Worth
  KDTW: { lat: 42.2124, lon: -83.3534 }, // DTW Metropolitan Wayne County
  KFLL: { lat: 26.0726, lon: -80.1527 }, // FLL Hollywood
  KIAD: { lat: 38.9445, lon: -77.4558 }, // IAD Dulles
  KIAH: { lat: 29.9844, lon: -95.3414 }, // IAH George Bush
  KIND: { lat: 39.7173, lon: -86.2944 }, // IND Indianapolis
  KITH: { lat: 42.491, lon: -76.4584 }, // ITH Tompkins Regional
  KJAX: { lat: 30.4941, lon: -81.6879 }, // JAX Jacksonville
  KLAS: { lat: 36.0801, lon: -115.152 }, // LAS Harry Reid
  KLAX: { lat: 33.9425, lon: -118.408 }, // LAX Los Angeles
  KMCO: { lat: 28.4294, lon: -81.309 }, // MCO Orlando
  KMIA: { lat: 25.7932, lon: -80.2906 }, // MIA Miami
  KMSP: { lat: 44.882, lon: -93.2218 }, // MSP Wold-Chamberlain
  KMSY: { lat: 29.9934, lon: -90.258 }, // MSY Louis Armstrong
  KONT: { lat: 34.056, lon: -117.601 }, // ONT Ontario
  KORD: { lat: 41.9786, lon: -87.9048 }, // ORD O'Hare
  KORF: { lat: 36.8946, lon: -76.2012 }, // ORF Norfolk
  KPHX: { lat: 33.4343, lon: -112.012 }, // PHX Sky Harbor
  KPIT: { lat: 40.4915, lon: -80.2329 }, // PIT Pittsburgh
  KPVD: { lat: 41.7326, lon: -71.4204 }, // PVD T.F. Green
  KPWM: { lat: 43.6462, lon: -70.3093 }, // PWM Portland Jetport
  KRDU: { lat: 35.8776, lon: -78.7875 }, // RDU Raleigh-Durham
  KRIC: { lat: 37.5052, lon: -77.3197 }, // RIC Richmond
  KROC: { lat: 43.1189, lon: -77.6724 }, // ROC Greater Rochester
  KRSW: { lat: 26.5362, lon: -81.7552 }, // RSW Southwest Florida
  KSAN: { lat: 32.7336, lon: -117.19 }, // SAN San Diego
  KSAV: { lat: 32.1276, lon: -81.2021 }, // SAV Savannah
  KSEA: { lat: 47.449, lon: -122.309 }, // SEA Tacoma
  KSFO: { lat: 37.619, lon: -122.375 }, // SFO San Francisco
  KSLC: { lat: 40.7884, lon: -111.978 }, // SLC Salt Lake City
  KSNA: { lat: 33.6757, lon: -117.868 }, // SNA John Wayne
  KSYR: { lat: 43.1112, lon: -76.1063 }, // SYR Hancock
  KTPA: { lat: 27.9755, lon: -82.5332 }, // TPA Tampa
  LEMD: { lat: 40.4936, lon: -3.5668 }, // MAD Adolfo Suárez-Barajas
  LFPG: { lat: 49.0128, lon: 2.55 }, // CDG Charles de Gaulle
  LGAV: { lat: 37.9364, lon: 23.9445 }, // ATH Eleftherios Venizelos
  LIMC: { lat: 45.6306, lon: 8.7281 }, // MXP Malpensa
  LIPZ: { lat: 45.5053, lon: 12.3519 }, // VCE Marco Polo
  LIRF: { lat: 41.8045, lon: 12.2508 }, // FCO Leonardo da Vinci-Fiumicino
  LLBG: { lat: 32.0114, lon: 34.8867 }, // TLV Ben Gurion
  LPPR: { lat: 41.2481, lon: -8.6814 }, // OPO Francisco de Sá Carneiro
  LPPT: { lat: 38.7813, lon: -9.1359 }, // LIS Portela
  LSZH: { lat: 47.4647, lon: 8.5492 }, // ZRH Kloten
  LTFM: { lat: 41.2753, lon: 28.7519 }, // IST Istanbul
  LYBE: { lat: 44.8184, lon: 20.3091 }, // BEG Nikola Tesla
  MDPC: { lat: 18.5674, lon: -68.3634 }, // PUJ Punta Cana
  MDSD: { lat: 18.4297, lon: -69.6689 }, // SDQ Las Américas
  MDST: { lat: 19.4061, lon: -70.6047 }, // STI Cibao
  MKJP: { lat: 17.9357, lon: -76.7875 }, // KIN Norman Manley
  MMMX: { lat: 19.4363, lon: -99.0721 }, // MEX Licenciado Benito Juárez
  MMMY: { lat: 25.7785, lon: -100.107 }, // MTY General Mariano Escobedo
  MMSD: { lat: 23.1518, lon: -109.721 }, // SJD Los Cabos
  MRLB: { lat: 10.5933, lon: -85.5444 }, // LIR Daniel Oduber Quirós
  MROC: { lat: 9.9939, lon: -84.2088 }, // SJO Juan Santamaría
  MYNN: { lat: 25.039, lon: -77.4662 }, // NAS Lynden Pindling
  NZAA: { lat: -37.0081, lon: 174.792 }, // AKL Auckland
  OJAI: { lat: 31.7226, lon: 35.9932 }, // AMM Queen Alia (Amman, Jordan)
  OMAA: { lat: 24.433, lon: 54.6511 }, // AUH Zayed
  OMDB: { lat: 25.2528, lon: 55.3644 }, // DXB Dubai
  OTHH: { lat: 25.2731, lon: 51.6081 }, // DOH Hamad
  RCTP: { lat: 25.0777, lon: 121.233 }, // TPE Taiwan Taoyuan
  RJTT: { lat: 35.5523, lon: 139.78 }, // HND Haneda
  RKSI: { lat: 37.4691, lon: 126.451 }, // ICN Incheon
  SAEZ: { lat: -34.8222, lon: -58.5358 }, // EZE Ministro Pistarini
  SBGL: { lat: -22.81, lon: -43.2506 }, // GIG RIOgaleão-Tom Jobim
  SBGR: { lat: -23.4356, lon: -46.4731 }, // GRU Guarulhos
  SCEL: { lat: -33.393, lon: -70.7858 }, // SCL Comodoro Arturo Merino Benítez
  SEGU: { lat: -2.1574, lon: -79.8836 }, // GYE José Joaquín de Olmedo
  SKCG: { lat: 10.4424, lon: -75.513 }, // CTG Rafael Núñez
  SYCJ: { lat: 6.4985, lon: -58.2541 }, // GEO Cheddi Jagan (Guyana)
  TAPA: { lat: 17.1367, lon: -61.7927 }, // ANU V.C. Bird
  TBPB: { lat: 13.0746, lon: -59.4925 }, // BGI Sir Grantley Adams
  TGPY: { lat: 12.0042, lon: -61.7862 }, // GND Point Salines
  TJSJ: { lat: 18.4394, lon: -66.0018 }, // SJU Luis Muñoz Marín
  TLPL: { lat: 13.7332, lon: -60.9526 }, // UVF Hewanorra
  TNCA: { lat: 12.5014, lon: -70.0152 }, // AUA Queen Beatrix (Aruba)
  TNCC: { lat: 12.1889, lon: -68.9598 }, // CUR Curaçao Hato
  TTPP: { lat: 10.5954, lon: -61.3372 }, // POS Piarco
  VHHH: { lat: 22.3089, lon: 113.915 }, // HKG Chek Lap Kok
  VIDP: { lat: 28.5665, lon: 77.1031 }, // DEL Indira Gandhi
  WSSS: { lat: 1.3502, lon: 103.994 }, // SIN Changi
  ZBAA: { lat: 40.0801, lon: 116.585 }, // PEK Capital
  ZGGG: { lat: 23.3924, lon: 113.299 }, // CAN Baiyun
};
