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
export type TrackedAction = 'none' | 'resolve' | 'reresolve' | 'poll' | 'drop';

export interface LatLon {
  lat: number;
  lon: number;
}

/** What resolve.ts returns on success. */
export interface ResolvedFlight {
  icao24: string | null;
  reg: string | null;
  origIata: string | null;
  destIata: string | null;
  orig: LatLon | null;
  dest: LatLon | null;
  schedDepEpoch: number | null;
  schedArrEpoch: number | null;
}

export interface TrackedEntry {
  id: string;
  /** Normalised: uppercase, no spaces. "ba 181" -> "BA181". */
  number: string;
  /** ISO date, "YYYY-MM-DD". */
  date: string;
  state: TrackedState;
  /** Human-readable why, set when state is `unresolved`. Null otherwise. */
  reason: string | null;
  /** Transport-error retries used so far. Reset on success. */
  attempts: number;
  /** When `state` was last assigned. Drives the expiry timers. */
  stateAtMs: number;
  /** True once resolve #2 has run, so it runs at most once. */
  reresolved: boolean;
  icao24: string | null;
  reg: string | null;
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
}
