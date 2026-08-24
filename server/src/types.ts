/** One aircraft as reported by the position source, in source units. */
export interface Aircraft {
  hex: string;
  callsign: string;
  registration: string | null;
  typeIcao: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  groundspeedKt: number | null;
  trackDeg: number | null;
  verticalRateFpm: number | null;
  onGround: boolean;
  category: string | null;   // adsb.lol uses "A1".."A7"; A7 = rotorcraft
  distanceNm: number | null; // adsb.lol precomputes this ("dst")
  bearingDeg: number | null; // adsb.lol precomputes this ("dir")
}

/** One scheduled leg, as stored in KV. */
export interface ScheduleRow {
  /** Operating callsign, if the provider supplies it. Enables exact matching. */
  callsign: string | null;
  /** Marketing carrier IATA, e.g. "DL". */
  carrierIata: string;
  /** Flight number digits only, leading zeros stripped, e.g. "5075". */
  number: string;
  origIata: string | null;
  destIata: string | null;
  /**
   * BOTH ends need coordinates. matchSchedule measures how far off the
   * origin->destination corridor the aircraft sits, which needs two points; a
   * destination alone only answers "is it far away", which is not the same
   * question. A FIDS row supplies the far end, so the board's own airport
   * coordinates must be filled in for the near end.
   */
  origLat: number | null;
  origLon: number | null;
  destLat: number | null;
  destLon: number | null;
  /** Scheduled arrival, epoch seconds, for time disambiguation. */
  schedArrEpoch: number | null;
  /**
   * The operator's revised/delay-aware arrival estimate, epoch seconds, when
   * the provider supplies one -- AeroDataBox's `revisedTime`. This is a
   * DIFFERENT value from `schedArrEpoch`: scheduled is the published
   * timetable entry and never moves; revised is updated as the flight
   * actually progresses, so it already reflects a known delay or an early
   * run. Present far less often than schedArrEpoch (verified against
   * fixtures/fids-kjfk.json: 259/261 rows carry a scheduled time, 102/261
   * carry a revised one) -- most rows simply have no update to report yet.
   */
  revArrEpoch: number | null;
  /**
   * Which provider this row came from: `adb` AeroDataBox, `pa` Port Authority.
   *
   * Optional, and absent on every table written before two sources existed --
   * treat `undefined` as "not Port Authority", which is what it was. Used only
   * by refreshPanynj, to know which rows its own next pass supersedes; without
   * it, stale Port Authority rows would accumulate on every merge until the
   * 6-hourly AeroDataBox pass reset the table. Nothing downstream of the
   * schedule table reads it.
   */
  src?: 'adb' | 'pa';
}

/** A display-ready flight, in the units the device renders. */
/**
 * THE WIRE SHAPE. This is a contract with a second implementation that cannot
 * be refactored alongside it: firmware/adapters/FlightWallServerFetcher.cpp
 * reads these keys by literal string, on devices already on walls.
 *
 * So: renaming or removing a key here is a BREAKING change and needs the path
 * to move to /v2/flights. Adding an optional key is safe -- the firmware
 * ignores what it does not read.
 *
 * A rename fails silently, which is why this is written down rather than
 * assumed: the firmware's optNum()/optStr() helpers degrade a missing key to
 * "no value", so the field just stops appearing on the panel with no error on
 * either side. There is no shared fixture and deliberately so -- for two
 * implementations at this scale, a grep plus this comment beats a schema
 * pipeline. What that costs is that keys are pinned only by tests naming them,
 * so test/enrich.test.ts asserts every one of them explicitly.
 */
export interface Flight {
  cs: string;
  flt: string | null;
  al: string | null;
  reg: string | null;
  ac: string | null;
  from: string | null;
  to: string | null;
  alt: number | null;
  spd: number | null;
  hdg: number | null;
  vs: number | null;
  dst: number;
  brg: number;
  eta_min: number | null;
  eta_text: string | null;
  /**
   * Which source produced eta_min/eta_text: 'revised' or 'scheduled' means a
   * real arrival time from the operator (via the schedule table); 'physics'
   * means a model estimate from current position/speed/altitude, used when
   * no usable schedule time exists. A schedule-derived source is a fact
   * about a plan (and, for 'revised', a delay-aware one); 'physics' is a
   * guess about the future -- consumers should weight the two differently,
   * which is the whole reason this is three states and not a boolean.
   */
  eta_src: 'revised' | 'scheduled' | 'physics' | null;
}
