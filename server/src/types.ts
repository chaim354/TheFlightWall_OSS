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
}

/** A display-ready flight, in the units the device renders. */
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
  eta_src: 'physics' | null;
}
