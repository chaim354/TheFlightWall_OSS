/** Lifecycle states. See docs/superpowers/specs/2026-08-24-tracked-flights-design.md. */
export type TrackedState =
  | 'pending'
  | 'resolved'
  | 'airborne'
  | 'landed'
  | 'unresolved'
  | 'expired';

/** What the caller should DO about an entry this tick. Separate from state so
 * the state machine stays pure: it never performs the call it asks for. */
export type TrackedAction = 'none' | 'resolve' | 'reresolve' | 'poll' | 'findhex' | 'drop';

export interface LatLon {
  lat: number;
  lon: number;
}

/** What resolve.ts returns on success. */
export interface ResolvedFlight {
  icao24: string | null;
  /**
   * The OPERATING carrier's ADS-B callsign, e.g. "BAW181" for BA181.
   *
   * AeroDataBox returns it as `callSign` and it was being discarded. It is what
   * makes a pinned card look like every other card: the device derives the
   * operator (and so the logo tile, and the airline name when nothing else
   * supplies one) by taking the first three letters of the callsign, which
   * only works on the ICAO form. A tracked entry's `number` is the IATA form
   * the user typed -- "DL1732" -- whose first three characters are "DL1", so
   * the parse failed and the card rendered with no logo at all.
   *
   * Operating, not marketing, and that is correct: a Delta-sold flight actually
   * flown by Endeavor squawks EDV, so the tile matches the aircraft overhead
   * while `al` still says who sold the seat.
   */
  callsign: string | null;
  reg: string | null;
  /** e.g. "Boeing 777-300ER Passenger" -- AeroDataBox's aircraft.model. */
  aircraftModel: string | null;
  /**
   * ICAO type code, e.g. "B77W" -- hexdb.io, keyed on the hex above.
   *
   * The field the panel actually renders, because it is the one an AREA card
   * carries (adsb.lol's typeIcao) and a pinned card should not name the same
   * aircraft in a different vocabulary. aircraftModel is kept as the fallback
   * for when hexdb has nothing: see src/tracked/aircraftType.ts.
   */
  aircraftType: string | null;
  origIata: string | null;
  destIata: string | null;
  orig: LatLon | null;
  dest: LatLon | null;
  schedDepEpoch: number | null;
  schedArrEpoch: number | null;
}

/** Who put an entry in the store. See TrackedEntry.source. */
export type TrackedSource = 'manual' | 'calendar';

export interface TrackedEntry {
  id: string;
  /** Normalised: uppercase, no spaces. "ba 181" -> "BA181". */
  number: string;
  /** ISO date, "YYYY-MM-DD". */
  date: string;
  /**
   * The route the person asked for, IATA, when they named one -- the answer to
   * "which BA181?" on a date that has more than one.
   *
   * A flight number is not unique within a day. It is reused for the return
   * leg (LHR-JFK in the morning, JFK-LHR in the evening) and for the next hop
   * of a rotation (EK214 is BOG-MIA-DXB), and resolve.ts had no way to tell
   * which one the person meant. It guessed by clock -- the leg in the air, else
   * the next to depart -- which is right at departure time and wrong every
   * other time: an entry added the night before resolves hours ahead of the
   * first leg, so "next to depart" picks the MORNING flight for someone booked
   * on the evening one, and the wall then tracks a stranger's aeroplane.
   *
   * Nothing in the payload can settle that; only the person holding the
   * boarding pass knows. So this is what they type, and resolve.ts filters the
   * day's legs by it BEFORE the clock heuristic runs.
   *
   * Null means "no preference" -- either half independently, so "from JFK" is
   * expressible without naming the far end. That is the pre-existing behaviour
   * exactly, and it is also what every entry stored before this field existed
   * reads as, and what a calendar-sourced entry gets (an ICS event carries no
   * route; see calendar.ts's CalendarFlight).
   */
  wantOrigIata: string | null;
  wantDestIata: string | null;
  state: TrackedState;
  /** Human-readable why, set when state is `unresolved`. Null otherwise. */
  reason: string | null;
  /** Transport-error retries used so far. Reset on success. */
  attempts: number;
  /** When `state` was last assigned. Drives the expiry timers. */
  stateAtMs: number;
  /** True once resolve #2 has run, so it runs at most once. */
  reresolved: boolean;
  /**
   * Who put this entry here, and therefore who is allowed to remove it.
   *
   * Null on entries stored before this field existed -- the same
   * back-compatible-nullable shape `callsign` and `aircraftType` use. Null is
   * READ AS 'manual', which is the safe direction: the calendar sync deletes
   * only what it can prove it created, so an entry of unknown provenance is
   * never something it feels entitled to remove.
   */
  source: TrackedSource | null;
  icao24: string | null;
  /** Operating ADS-B callsign; see ResolvedFlight.callsign. Null on entries
   * resolved before this field existed -- serve.ts falls back to `number`. */
  callsign: string | null;
  reg: string | null;
  aircraftModel: string | null;
  /** ICAO type code; see ResolvedFlight.aircraftType. Null on entries resolved
   * before this field existed, and whenever hexdb has no answer. */
  aircraftType: string | null;
  origIata: string | null;
  destIata: string | null;
  orig: LatLon | null;
  dest: LatLon | null;
  schedDepEpoch: number | null;
  schedArrEpoch: number | null;
  /** Last observed position, live or estimated. */
  lastLat: number | null;
  lastLon: number | null;
  lastPosAtMs: number | null;
  /**
   * Last values OpenSky reported alongside lastLat/lastLon, from the same
   * poll (see tick.ts). Independent nulls, not one all-or-nothing flag:
   * OpenSky's own state vector nulls each field separately when a receiver
   * has some data but not all of it, and collapsing that into a single
   * "have dynamics" bit would either invent a value for a field that was
   * genuinely absent or discard a field that was genuinely present.
   */
  lastAltFt: number | null;
  lastGroundspeedKt: number | null;
  lastHeadingDeg: number | null;
  lastVerticalRateFpm: number | null;
}
